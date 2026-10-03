import { describe, expect, it } from "vitest";
import type { AxcutClip } from "../schema";
import {
	DEFAULT_EDGE_SILENCE_POLICY,
	EDGE_TRIM_REASON,
	GAP_TRIM_REASON,
	planEdgeSilence,
} from "./edge-silence";

const clip: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 7,
	timelineStartSec: 0,
	timelineEndSec: 7,
	wordRefs: [],
	origin: "user",
	reason: "",
};

function peaks(loudRanges: Array<[number, number]>, durationSec = 7): Float32Array {
	const blocks = Math.ceil(durationSec / 0.01);
	const value = new Float32Array(blocks * 2);
	for (let index = 0; index < blocks; index += 1) {
		const time = index * 0.01;
		const loud = loudRanges.some(([start, end]) => time >= start && time < end);
		const amplitude = loud ? 0.3 : 0.003;
		value[index * 2] = -amplitude;
		value[index * 2 + 1] = amplitude;
	}
	return value;
}

function envelope(activeRanges: Array<[number, number]>, durationSec = 7): Float32Array {
	const value = new Float32Array(Math.ceil(durationSec / 0.032));
	for (let index = 0; index < value.length; index += 1) {
		const time = index * 0.032;
		value[index] = activeRanges.some(([start, end]) => time >= start && time < end) ? 0.9 : 0.02;
	}
	return value;
}

describe("edge silence", () => {
	it("cuts the dead air before the first word and after the last word", () => {
		const suggestions = planEdgeSilence({
			clip,
			durationSec: 7,
			speechProbabilities: envelope([[1.15, 5.55]]),
			speechFrameSec: 0.032,
		});
		expect(suggestions.map((s) => s.edge)).toEqual(["lead", "tail"]);
		expect(suggestions[0]?.sourceStartSec).toBe(0);
		expect(suggestions[0]?.sourceEndSec).toBeCloseTo(1.15 - 0.04 - 0.1, 1);
		expect(suggestions[1]?.sourceEndSec).toBe(7);
		expect(suggestions[1]?.sourceStartSec).toBeCloseTo(5.55 + 0.04 + 0.15, 1);
	});

	it("ignores a key click in the lead-in because only speech ends the dead air", () => {
		const suggestions = planEdgeSilence({
			clip,
			durationSec: 7,
			speechProbabilities: envelope([[1.15, 6.9]]),
			speechFrameSec: 0.032,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.edge).toBe("lead");
		expect(suggestions[0]?.sourceEndSec).toBeGreaterThan(0.9);
	});

	it("leaves pauses inside the take alone", () => {
		const suggestions = planEdgeSilence({
			clip,
			durationSec: 7,
			speechProbabilities: envelope([
				[0.05, 2],
				[4, 6.95],
			]),
			speechFrameSec: 0.032,
		});
		expect(suggestions).toEqual([]);
	});

	it("skips a take with no detected speech and a clip longer than the limit", () => {
		expect(
			planEdgeSilence({
				clip,
				durationSec: 7,
				speechProbabilities: envelope([]),
				speechFrameSec: 0.032,
			}),
		).toEqual([]);
		expect(
			planEdgeSilence(
				{ clip, durationSec: 7, speechProbabilities: envelope([[1, 5]]), speechFrameSec: 0.032 },
				{ ...DEFAULT_EDGE_SILENCE_POLICY, maximumClipSec: 5 },
			),
		).toEqual([]);
	});

	it("does not propose an edge that already carries a trim", () => {
		const suggestions = planEdgeSilence({
			clip,
			durationSec: 7,
			speechProbabilities: envelope([[1.15, 5.55]]),
			speechFrameSec: 0.032,
			existingTrims: [
				{
					id: "trim_lead",
					assetId: "asset_1",
					clipId: "clip_1",
					startSec: 0,
					endSec: 1,
					reason: EDGE_TRIM_REASON,
					origin: "agent",
				},
			],
		});
		expect(suggestions.map((s) => s.edge)).toEqual(["tail"]);
	});

	it("cuts a long detector-confirmed gap and leaves short pauses", () => {
		const suggestions = planEdgeSilence({
			clip,
			durationSec: 7,
			speechProbabilities: envelope([
				[0, 2],
				[2.5, 4],
				[5.8, 7],
			]),
			speechFrameSec: 0.032,
			microphonePeaks: peaks([
				[0, 2],
				[2.5, 4],
				[5.8, 7],
			]),
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.edge).toBe("gap");
		expect(suggestions[0]?.reason).toBe(GAP_TRIM_REASON);
		expect(suggestions[0]?.sourceStartSec).toBeGreaterThanOrEqual(4 + 0.15);
		expect(suggestions[0]?.sourceEndSec).toBeLessThanOrEqual(5.8 - 0.1);
		expect(suggestions[0]?.savedSec).toBeGreaterThan(1.3);
	});

	it("skips a gap that overlaps an edge cut or an existing trim, and min_gap 0 turns gaps off", () => {
		const input = {
			clip,
			durationSec: 7,
			speechProbabilities: envelope([[3, 6.95]]),
			speechFrameSec: 0.032,
			microphonePeaks: peaks([
				[0, 0.5],
				[3, 7],
			]),
		};
		expect(planEdgeSilence(input).map((s) => s.edge)).toEqual(["lead"]);
		expect(
			planEdgeSilence(
				{ ...input, speechProbabilities: envelope([[0.05, 6.95]]) },
				{ ...DEFAULT_EDGE_SILENCE_POLICY, minimumGapSec: 0 },
			),
		).toEqual([]);
		expect(
			planEdgeSilence({
				...input,
				speechProbabilities: envelope([[0.05, 6.95]]),
				existingTrims: [
					{
						id: "trim_user",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 1,
						endSec: 1.5,
						reason: "",
						origin: "user",
					},
				],
			}),
		).toEqual([]);
	});
});

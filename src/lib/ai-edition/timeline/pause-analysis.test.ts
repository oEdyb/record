import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutTranscript } from "../schema";
import {
	analyzeClipPauses,
	DEFAULT_PAUSE_POLICY,
	type PauseAnalysisPolicy,
} from "./pause-analysis";

const clip: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 6,
	timelineStartSec: 0,
	timelineEndSec: 6,
	wordRefs: [],
	origin: "user",
	reason: "",
};

function peaks(activeRanges: Array<[number, number]>): Float32Array {
	const value = new Float32Array(6 * 200 * 2);
	for (let block = 0; block < value.length / 2; block += 1) {
		const time = block / 200;
		const amplitude = activeRanges.some(([start, end]) => time >= start && time < end)
			? 0.2
			: 0.001;
		value[block * 2] = -amplitude;
		value[block * 2 + 1] = amplitude;
	}
	return value;
}

function speechProbabilities(activeRanges: Array<[number, number]>): Float32Array {
	const value = new Float32Array(Math.ceil(6 / 0.032));
	for (let index = 0; index < value.length; index += 1) {
		const time = index * 0.032;
		value[index] = activeRanges.some(([start, end]) => time >= start && time < end) ? 0.9 : 0.02;
	}
	return value;
}

const transcript: AxcutTranscript = {
	assetId: "asset_1",
	language: "en",
	segments: [],
	words: [
		{ id: "w1", segmentId: "s1", startSec: 0.2, endSec: 1.1, text: "hello" },
		{ id: "w2", segmentId: "s2", startSec: 4.8, endSec: 5.6, text: "again" },
	],
};

function policy(patch: Partial<PauseAnalysisPolicy> = {}): PauseAnalysisPolicy {
	return { ...DEFAULT_PAUSE_POLICY, ...patch };
}

describe("pause analysis", () => {
	it("shortens the removable middle and keeps speech-side padding", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				speechFrameSec: 0.032,
				transcript,
			},
			policy(),
		);
		const middle = suggestions.find((suggestion) => suggestion.silenceStartSec > 1);
		expect(middle).toMatchObject({ clipId: "clip_1", assetId: "asset_1" });
		expect(middle?.sourceStartSec).toBeGreaterThan(1.1);
		expect(middle?.sourceEndSec).toBeLessThan(4.8);
		expect(middle?.savedSec).toBeGreaterThan(3);
	});

	it("does not silently fall back when Speech mode has no VAD envelope", () => {
		expect(
			analyzeClipPauses({ clip, durationSec: 6, microphonePeaks: peaks([]) }, policy()),
		).toEqual([]);
	});

	it("lets Silero drive Speech mode when no transcript is available", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0, 1],
					[5, 6],
				]),
				speechProbabilities: speechProbabilities([
					[0, 1],
					[5, 6],
				]),
				speechFrameSec: 0.032,
			},
			policy(),
		);
		expect(suggestions.some((suggestion) => suggestion.savedSec > 3)).toBe(true);
	});

	it("lets audio-level mode work without a transcript", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0, 1],
					[5, 6],
				]),
			},
			policy({ mode: "audio-level" }),
		);
		expect(suggestions.some((suggestion) => suggestion.savedSec > 3)).toBe(true);
	});

	it("protects system audio and screen activity", () => {
		const base = {
			clip,
			durationSec: 6,
			microphonePeaks: peaks([
				[0, 1],
				[5, 6],
			]),
			speechProbabilities: speechProbabilities([
				[0, 1],
				[5, 6],
			]),
			speechFrameSec: 0.032,
			transcript,
		};
		expect(
			analyzeClipPauses(
				{ ...base, systemPeaks: peaks([[1, 5]]) },
				policy({ protectSystemAudio: true }),
			),
		).toHaveLength(0);
		expect(
			analyzeClipPauses(
				{ ...base, screenActivity: [{ startSec: 1, endSec: 5 }] },
				policy({ protectScreenActivity: true }),
			),
		).toHaveLength(0);
	});
});

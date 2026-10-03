import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutTranscript, AxcutWord } from "../schema";
import { planCutPoint } from "./cut-point";
import { planEdgeSilence } from "./edge-silence";
import { analyzeClipPauses, DEFAULT_PAUSE_POLICY } from "./pause-analysis";

const clip: AxcutClip = {
	id: "clip",
	assetId: "asset",
	sourceStartSec: 0,
	sourceEndSec: 6,
	timelineStartSec: 0,
	timelineEndSec: 6,
	wordRefs: [],
	origin: "user",
	reason: "",
};
function word(text: string, startSec: number, endSec: number): AxcutWord {
	return { id: `${text}_${startSec}`, segmentId: "s", text, startSec, endSec, sourceRole: "you" };
}
function transcript(words: AxcutWord[]): AxcutTranscript {
	return { assetId: "asset", language: "en", sources: [], segments: [], words };
}
function peaks(ranges: number[][], duration = 6): Float32Array {
	return Float32Array.from({ length: duration * 200 }, (_, index) => {
		const time = Math.floor(index / 2) / 100;
		return ranges.some(([start, end]) => time >= start && time < end) ? 0.2 : 0.001;
	});
}
function vad(ranges: number[][], duration = 6, probability = 0.9): Float32Array {
	return Float32Array.from({ length: Math.ceil(duration / 0.032) }, (_, index) =>
		ranges.some(([start, end]) => index * 0.032 >= start && index * 0.032 < end)
			? probability
			: 0.02,
	);
}
const base = {
	clip,
	durationSec: 6,
	microphonePeaks: peaks([
		[0, 1],
		[5, 6],
	]),
	speechProbabilities: vad([
		[0, 2],
		[4, 6],
	]),
	speechFrameSec: 0.032,
};
const kimiWords = [
	word("So", 17.47, 17.8),
	word("it's", 17.8, 18.16),
	word("very", 18.08, 18.43),
	word("zoomed", 18.43, 18.84),
	word("in,", 18.84, 19.16),
	word("that's", 19.16, 19.56),
	word("my", 19.56, 19.84),
	word("first", 19.84, 20.06),
	word("impression.", 20.06, 22.76),
	word("For", 22.76, 23.06),
	word("sure.", 23.06, 23.73),
];

describe("automatic cut safety", () => {
	it.each([
		undefined,
		transcript([word("early", 0.1, 0.8)]),
	])("does not widen detector silence without words on both sides: %j", (text) => {
		const cuts = analyzeClipPauses({ ...base, transcript: text });
		expect(cuts).toHaveLength(1);
		expect(cuts[0].silenceStartSec).toBeGreaterThanOrEqual(2);
		expect(cuts[0].silenceEndSec).toBeLessThanOrEqual(4);
	});
	it("does not exempt an uncertain speech island without surrounding transcript", () => {
		const cuts = analyzeClipPauses({
			...base,
			microphonePeaks: peaks([
				[0, 1],
				[2.8, 3.1],
				[5, 6],
			]),
			speechProbabilities: vad(
				[
					[0, 1],
					[2.8, 3.1],
					[5, 6],
				],
				6,
				0.7,
			),
		});
		expect(cuts.length).toBeGreaterThan(0);
		expect(cuts.every((cut) => cut.sourceEndSec <= 2.8 || cut.sourceStartSec >= 3.1)).toBe(true);
	});
	it("keeps quiet speech islands protected even between trusted transcript words", () => {
		const cuts = analyzeClipPauses({
			...base,
			transcript: transcript([word("First.", 0, 1), word("Next", 5, 6)]),
			cleanedSpeechProbabilities: vad([
				[0, 1],
				[2.8, 3.1],
				[5, 6],
			]),
		});
		expect(cuts.length).toBeGreaterThan(0);
		expect(cuts.every((cut) => cut.sourceEndSec <= 2.8 || cut.sourceStartSec >= 3.1)).toBe(true);
	});

	it("rejects an envelope missing even its final frame", () => {
		expect(analyzeClipPauses({ ...base, speechProbabilities: vad([[0, 1]]).slice(0, -1) })).toEqual(
			[],
		);
	});
	it("does not cut a short within-sentence gap even when audio is silent", () => {
		const text = transcript([word("still", 0, 2), word("speaking", 2.7, 6)]);
		expect(
			analyzeClipPauses(
				{
					...base,
					transcript: text,
					microphonePeaks: peaks([
						[0, 2],
						[2.7, 6],
					]),
					speechProbabilities: vad([]),
				},
				{ ...DEFAULT_PAUSE_POLICY, minimumPauseSec: 0.8 },
			),
		).toEqual([]);
	});
	it.each([
		"finished.",
		"continuing",
	])("keeps a real long transcript gap after %s eligible", (text) => {
		const cuts = analyzeClipPauses({
			...base,
			transcript: transcript([word(text, 0, 1), word("next", 5, 6)]),
		});
		expect(cuts).toHaveLength(1);
		expect(cuts[0].silenceStartSec).toBeLessThan(1.5);
		expect(cuts[0].silenceEndSec).toBeGreaterThan(4.5);
	});
	it.each([
		"system",
		"unknown-mixed",
		undefined,
	] as const)("does not trust %s words for widening", (sourceRole) => {
		const cuts = analyzeClipPauses({
			...base,
			transcript: transcript(
				[word("end.", 0, 1), word("Next", 5, 6)].map((w) => ({ ...w, sourceRole })),
			),
		});
		expect(cuts).toHaveLength(1);
		expect(cuts[0].silenceStartSec).toBeGreaterThanOrEqual(2);
	});
	it("does not trust a transcript from another asset", () => {
		const cuts = analyzeClipPauses({
			...base,
			transcript: { ...transcript([word("end.", 0, 1), word("Next", 5, 6)]), assetId: "other" },
		});
		expect(cuts[0].silenceStartSec).toBeGreaterThanOrEqual(2);
	});
	it("keeps raw and cleaned speech protected in uncovered regions", () => {
		const cuts = analyzeClipPauses({
			...base,
			cleanedSpeechProbabilities: vad([
				[0, 3],
				[3.5, 6],
			]),
		});
		expect(cuts).toEqual([]);
	});
	it("rejects partial cleaned evidence even when raw evidence is complete", () => {
		expect(
			analyzeClipPauses({ ...base, cleanedSpeechProbabilities: vad([]).slice(0, 60) }),
		).toEqual([]);
	});
	it("does not let edges cut mic quietness marked as speech", () => {
		expect(planEdgeSilence({ ...base, speechProbabilities: vad([[0, 6]]) })).toEqual([]);
	});
	it("does not let edges infer a tail from a partial envelope", () => {
		expect(planEdgeSilence({ ...base, speechProbabilities: vad([[0, 1]]).slice(0, 50) })).toEqual(
			[],
		);
	});
	it("keeps the real Kimi words protected from automatic pauses", () => {
		const kimiClip = { ...clip, sourceStartSec: 17.47, sourceEndSec: 23.73 };
		expect(
			analyzeClipPauses({
				clip: kimiClip,
				durationSec: 24,
				transcript: transcript(kimiWords),
				microphonePeaks: peaks(
					[
						[17.47, 20.68],
						[21.06, 21.24],
						[22.14, 22.24],
					],
					24,
				),
				speechProbabilities: vad([], 24),
				speechFrameSec: 0.032,
			}),
		).toEqual([]);
	});
	it("does not choose Kimi's first in-word quiet pocket as its sentence end", () => {
		const result = planCutPoint({
			clip: { ...clip, sourceStartSec: 17.47, sourceEndSec: 24 },
			durationSec: 24,
			words: kimiWords,
			timeSec: 20,
			edge: "out",
			microphonePeaks: peaks(
				[
					[17.47, 20.68],
					[21.06, 21.24],
					[22.14, 22.24],
					[22.7, 23.73],
				],
				24,
			),
			speechProbabilities: vad([[17.47, 20.68]], 24),
			speechFrameSec: 0.032,
		});
		expect(result.chosen).toMatchObject({ method: "transcript", transcriptSec: 22.76 });
		expect(result.chosen?.cutSec).toBeGreaterThanOrEqual(22.76);
	});
	it("uses the final sustained silence across a smeared word end", () => {
		const result = planCutPoint({
			...base,
			timeSec: 1,
			edge: "out",
			words: [word("sentence.", 0, 4.5), word("Next", 5, 6)],
			microphonePeaks: peaks([
				[0, 1],
				[1.5, 2],
				[2.8, 3],
			]),
		});
		expect(result.chosen).toMatchObject({ method: "mic-level", audioSec: 3 });
	});
	it("protects a single detector-positive frame at the clip edge", () => {
		const probabilities = vad([[5, 6]]);
		probabilities[0] = 0.9;
		const cuts = analyzeClipPauses({
			...base,
			microphonePeaks: peaks([[5, 6]]),
			speechProbabilities: probabilities,
		});
		expect(cuts.every((cut) => cut.sourceStartSec > 0.032)).toBe(true);
	});
	it("rejects non-finite detector evidence", () => {
		const probabilities = vad([]);
		probabilities[50] = Number.NaN;
		expect(analyzeClipPauses({ ...base, speechProbabilities: probabilities })).toEqual([]);
	});
	it("does not use transcript words outside a source-trimmed clip as blip permission", () => {
		const cuts = analyzeClipPauses({
			...base,
			clip: { ...clip, sourceStartSec: 1.5, sourceEndSec: 4.5 },
			transcript: transcript([word("before", 0, 1), word("after", 5, 6)]),
			microphonePeaks: peaks([[2.8, 3.1]]),
			speechProbabilities: vad([[2.8, 3.1]], 6, 0.7),
		});
		expect(cuts.every((cut) => cut.sourceEndSec <= 2.8 || cut.sourceStartSec >= 3.1)).toBe(true);
	});
	it("keeps missing-word microphone activity protected", () => {
		const cuts = analyzeClipPauses({
			...base,
			microphonePeaks: peaks([
				[0, 1],
				[2.8, 3.1],
				[5, 6],
			]),
			speechProbabilities: vad([
				[0, 1],
				[5, 6],
			]),
		});
		expect(cuts.length).toBeGreaterThan(0);
		expect(cuts.every((cut) => cut.sourceEndSec <= 2.8 || cut.sourceStartSec >= 3.1)).toBe(true);
	});
	it("does not use a truncated detector as cutpoint refinement", () => {
		const result = planCutPoint({
			...base,
			words: [word("End.", 0, 1)],
			timeSec: 1,
			edge: "out",
			microphonePeaks: null,
			speechProbabilities: vad([[0, 2]]).slice(0, 70),
		});
		expect(result.chosen?.method).toBe("transcript");
	});
	it.each([
		[0.013, 6],
		[0, 5.987],
		[0.013, 5.987],
	])("preserves both silent edges for off-grid source bounds %s–%s", (startSec, endSec) => {
		const cuts = analyzeClipPauses({
			...base,
			clip: { ...clip, sourceStartSec: startSec, sourceEndSec: endSec },
			microphonePeaks: peaks([[2, 4]]),
			speechProbabilities: vad([[2, 4]]),
		});
		expect(cuts).toHaveLength(2);
		expect(cuts[0].silenceStartSec).toBe(startSec);
		expect(cuts[0].sourceStartSec).toBe(startSec);
		expect(cuts[0].sourceEndSec).toBeGreaterThan(1.75);
		expect(cuts[0].sourceEndSec).toBeLessThanOrEqual(2 - DEFAULT_PAUSE_POLICY.keepBeforeSec);
		expect(cuts[1].silenceEndSec).toBe(endSec);
		expect(cuts[1].sourceEndSec).toBe(endSec);
		expect(cuts[1].sourceStartSec).toBeGreaterThanOrEqual(4 + DEFAULT_PAUSE_POLICY.keepAfterSec);
		expect(cuts[1].sourceStartSec).toBeLessThan(4.3);
	});
	it.each(["raw", "cleaned"])("protects %s speech in partial boundary frames", (detector) => {
		const edgeSpeech = vad([
			[0, 0.3],
			[2, 4],
			[5.7, 6],
		]);
		const cuts = analyzeClipPauses({
			...base,
			clip: { ...clip, sourceStartSec: 0.013, sourceEndSec: 5.987 },
			microphonePeaks: peaks([[2, 4]]),
			speechProbabilities: detector === "raw" ? edgeSpeech : vad([[2, 4]]),
			cleanedSpeechProbabilities: detector === "cleaned" ? edgeSpeech : null,
		});
		expect(cuts).toHaveLength(2);
		expect(cuts[0].sourceStartSec).toBeGreaterThan(0.3);
		expect(cuts[1].sourceEndSec).toBeLessThan(5.7);
	});
	it("still rejects incomplete envelopes for off-grid source edges", () => {
		expect(
			analyzeClipPauses({
				...base,
				clip: { ...clip, sourceStartSec: 0.013, sourceEndSec: 5.987 },
				microphonePeaks: peaks([[2, 4]]),
				speechProbabilities: vad([[2, 4]]).slice(0, -1),
			}),
		).toEqual([]);
	});
});

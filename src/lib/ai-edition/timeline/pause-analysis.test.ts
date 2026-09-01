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

function peaksAboveFloor(floor: number, activeRanges: Array<[number, number]>): Float32Array {
	const value = new Float32Array(6 * 200 * 2);
	for (let block = 0; block < value.length / 2; block += 1) {
		const time = block / 200;
		const amplitude = activeRanges.some(([start, end]) => time >= start && time < end)
			? 0.2
			: floor;
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
	sources: [],
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

	it("does not let system-audio words protect silence on the microphone track", () => {
		const withSystemWord: AxcutTranscript = {
			...transcript,
			words: [
				...transcript.words.map((word) => ({ ...word, sourceRole: "you" as const })),
				{
					id: "system_word",
					segmentId: "system_segment",
					startSec: 2.5,
					endSec: 3.5,
					text: "system",
					sourceRole: "system",
				},
			],
		};
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
				transcript: withSystemWord,
			},
			policy(),
		);

		expect(
			suggestions.some(
				(suggestion) => suggestion.sourceStartSec < 2.5 && suggestion.sourceEndSec > 3.5,
			),
		).toBe(true);
	});

	it("includes a confident isolated non-speech burst inside one pause suggestion", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0.2, 1.1],
					[2.7, 3.1],
					[4.8, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				cleanedSpeechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				speechFrameSec: 0.032,
				transcript,
			},
			policy({ includeNonSpeechEvents: true }),
		);

		const middle = suggestions.find((suggestion) => suggestion.silenceStartSec > 1);
		expect(middle?.silenceStartSec).toBeLessThan(2);
		expect(middle?.silenceEndSec).toBeGreaterThan(4);
		expect(middle?.savedSec).toBeGreaterThan(3);
	});

	it("keeps a changing noise floor and a non-speech burst inside the removable pause", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaksAboveFloor(0.025, [
					[0.2, 1.1],
					[2.7, 3.1],
					[4.8, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				cleanedSpeechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				speechFrameSec: 0.032,
				transcript,
			},
			policy({ includeNonSpeechEvents: true }),
		);

		expect(
			suggestions.some(
				(suggestion) => suggestion.silenceStartSec < 2.7 && suggestion.silenceEndSec > 3.1,
			),
		).toBe(true);
	});

	it("protects the burst when cleaned analysis is absent or the option is disabled", () => {
		const input = {
			clip,
			durationSec: 6,
			microphonePeaks: peaks([
				[0.2, 1.1],
				[2.7, 3.1],
				[4.8, 5.6],
			]),
			speechProbabilities: speechProbabilities([
				[0.2, 1.1],
				[4.8, 5.6],
			]),
			speechFrameSec: 0.032,
			transcript,
		};
		const withoutCleaned = analyzeClipPauses(input, policy({ includeNonSpeechEvents: true }));
		const disabled = analyzeClipPauses(
			{
				...input,
				cleanedSpeechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
			},
			policy({ includeNonSpeechEvents: false }),
		);

		for (const suggestions of [withoutCleaned, disabled]) {
			expect(
				suggestions.some(
					(suggestion) => suggestion.silenceStartSec < 2.7 && suggestion.silenceEndSec > 3.1,
				),
			).toBe(false);
		}
	});

	it("protects an energy event that falls outside a truncated speech envelope", () => {
		const truncated = speechProbabilities([
			[0.2, 1.1],
			[4.8, 5.6],
		]).slice(0, 50);
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0.2, 1.1],
					[2.7, 3.1],
					[4.8, 5.6],
				]),
				speechProbabilities: truncated,
				cleanedSpeechProbabilities: truncated,
				speechFrameSec: 0.032,
				transcript,
			},
			policy({ includeNonSpeechEvents: true }),
		);

		expect(
			suggestions.some(
				(suggestion) => suggestion.silenceStartSec < 2.7 && suggestion.silenceEndSec > 3.1,
			),
		).toBe(false);
	});

	it("does not cut an otherwise quiet tail outside a truncated speech envelope", () => {
		const truncated = speechProbabilities([[0.2, 1.1]]).slice(0, 50);
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([[0.2, 1.1]]),
				speechProbabilities: truncated,
				cleanedSpeechProbabilities: truncated,
				speechFrameSec: 0.032,
			},
			policy(),
		);

		expect(suggestions).toEqual([]);
	});

	it("keeps screen activity protected when both speech views classify a burst as non-speech", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0.2, 1.1],
					[2.7, 3.1],
					[4.8, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				cleanedSpeechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				speechFrameSec: 0.032,
				transcript,
				screenActivity: [{ startSec: 1.1, endSec: 4.8 }],
			},
			policy({ includeNonSpeechEvents: true, protectScreenActivity: true }),
		);

		expect(suggestions).toHaveLength(0);
	});

	it("uses cleaned speech as protection and keeps an uncertain raw burst", () => {
		const baseProbabilities = speechProbabilities([
			[0.2, 1.1],
			[4.8, 5.6],
		]);
		const cleaned = speechProbabilities([
			[0.2, 1.1],
			[2.7, 3.1],
			[4.8, 5.6],
		]);
		const input = {
			clip,
			durationSec: 6,
			microphonePeaks: peaks([
				[0.2, 1.1],
				[2.7, 3.1],
				[4.8, 5.6],
			]),
			speechProbabilities: baseProbabilities,
			cleanedSpeechProbabilities: cleaned,
			speechFrameSec: 0.032,
			transcript,
		};
		const protectedByCleaned = analyzeClipPauses(input, policy({ includeNonSpeechEvents: true }));

		const uncertainRaw = baseProbabilities.slice();
		for (let index = 0; index < uncertainRaw.length; index += 1) {
			const time = index * 0.032;
			if (time >= 2.7 && time < 3.1) uncertainRaw[index] = 0.25;
		}
		const protectedByUncertainty = analyzeClipPauses(
			{
				...input,
				speechProbabilities: uncertainRaw,
				cleanedSpeechProbabilities: baseProbabilities,
			},
			policy({ includeNonSpeechEvents: true }),
		);

		for (const suggestions of [protectedByCleaned, protectedByUncertainty]) {
			expect(
				suggestions.some(
					(suggestion) => suggestion.silenceStartSec < 2.7 && suggestion.silenceEndSec > 3.1,
				),
			).toBe(false);
		}
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

	it("does not treat unknown mixed speech as verified microphone evidence", () => {
		const mixedTranscript: AxcutTranscript = {
			...transcript,
			words: [
				{
					id: "mixed_word",
					segmentId: "mixed_segment",
					startSec: 2.5,
					endSec: 3.5,
					text: "mixed",
					sourceRole: "unknown-mixed",
				},
			],
		};
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
				transcript: mixedTranscript,
			},
			policy(),
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

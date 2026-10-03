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
		{ id: "w1", segmentId: "s1", startSec: 0.2, endSec: 1.1, text: "hello", sourceRole: "you" },
		{ id: "w2", segmentId: "s2", startSec: 4.8, endSec: 5.6, text: "again", sourceRole: "you" },
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

	it("cuts a silent clip lead-in back to the speech-side padding only", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([[1.0, 6]]),
				speechProbabilities: speechProbabilities([[1.0, 6]]),
				speechFrameSec: 0.032,
				transcript: {
					...transcript,
					words: [{ id: "w1", segmentId: "s1", startSec: 1.0, endSec: 6, text: "hello" }],
				},
			},
			policy(),
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.sourceStartSec).toBe(0);
		expect(suggestions[0]?.sourceEndSec).toBeGreaterThan(0.7);
		expect(suggestions[0]?.sourceEndSec).toBeLessThanOrEqual(
			1.0 - DEFAULT_PAUSE_POLICY.keepBeforeSec,
		);
	});

	it("cuts a silent clip tail after the speech-side padding", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([[0, 5.0]]),
				speechProbabilities: speechProbabilities([[0, 5.0]]),
				speechFrameSec: 0.032,
				transcript: {
					...transcript,
					words: [{ id: "w1", segmentId: "s1", startSec: 0, endSec: 5.0, text: "hello" }],
				},
			},
			policy(),
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.sourceEndSec).toBe(6);
		expect(suggestions[0]?.sourceStartSec).toBeGreaterThanOrEqual(
			5.0 + DEFAULT_PAUSE_POLICY.keepAfterSec,
		);
		expect(suggestions[0]?.sourceStartSec).toBeLessThan(5.4);
	});

	it("never proposes removing a clip that is silent from start to end", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([]),
				speechProbabilities: speechProbabilities([]),
				speechFrameSec: 0.032,
				transcript: { ...transcript, words: [] },
			},
			policy(),
		);
		expect(suggestions).toEqual([]);
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
		expect(suggestions.some((suggestion) => suggestion.kind === "blip")).toBe(false);
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

	it("admits the burst without cleaned analysis and keeps it when the option is disabled", () => {
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

		const spansBurst = (suggestions: ReturnType<typeof analyzeClipPauses>) =>
			suggestions.some(
				(suggestion) => suggestion.silenceStartSec < 2.7 && suggestion.silenceEndSec > 3.1,
			);
		expect(spansBurst(withoutCleaned)).toBe(true);
		expect(spansBurst(disabled)).toBe(false);
	});

	it("keeps a wordless sound the detector calls speech, or one longer than half a second", () => {
		const base = {
			clip,
			durationSec: 6,
			speechFrameSec: 0.032,
			transcript,
		};
		const confident = analyzeClipPauses(
			{
				...base,
				microphonePeaks: peaks([
					[0.2, 1.1],
					[2.7, 3.1],
					[4.8, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[2.7, 3.1],
					[4.8, 5.6],
				]),
			},
			policy({ includeNonSpeechEvents: true }),
		);
		const long = analyzeClipPauses(
			{
				...base,
				microphonePeaks: peaks([
					[0.2, 1.1],
					[2.5, 3.2],
					[4.8, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
			},
			policy({ includeNonSpeechEvents: true }),
		);
		for (const suggestions of [confident, long]) {
			expect(
				suggestions.some(
					(suggestion) => suggestion.silenceStartSec < 2.7 && suggestion.silenceEndSec > 3.1,
				),
			).toBe(false);
			expect(suggestions.every((suggestion) => suggestion.kind === "pause")).toBe(true);
		}
	});

	it("widens only within trusted word margins past the detector's tail", () => {
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0.2, 1.1],
					[4.8, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 1.6],
					[4.3, 5.6],
				]),
				speechFrameSec: 0.032,
				transcript,
			},
			policy(),
		);
		const middle = suggestions.find((suggestion) => suggestion.silenceStartSec > 1);
		expect(middle?.silenceStartSec).toBeCloseTo(1.24, 2);
		expect(middle?.silenceEndSec).toBeCloseTo(4.72, 2);
	});
	it("proposes removing a wordless blip inside a sentence on its own", () => {
		const close: AxcutTranscript = {
			...transcript,
			words: [
				{ id: "w1", segmentId: "s1", startSec: 0.2, endSec: 2.5, text: "hello", sourceRole: "you" },
				{ id: "w2", segmentId: "s1", startSec: 3.3, endSec: 5.6, text: "again", sourceRole: "you" },
			],
		};
		const suggestions = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0.2, 2.5],
					[2.7, 3.1],
					[3.3, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 2.5],
					[3.3, 5.6],
				]),
				speechFrameSec: 0.032,
				transcript: close,
			},
			policy({ includeNonSpeechEvents: true }),
		);
		const blip = suggestions.find((suggestion) => suggestion.kind === "blip");
		expect(blip).toBeDefined();
		const click = analyzeClipPauses(
			{
				clip,
				durationSec: 6,
				microphonePeaks: peaks([
					[0.2, 2.5],
					[2.8, 2.88],
					[3.3, 5.6],
				]),
				speechProbabilities: speechProbabilities([
					[0.2, 2.5],
					[3.3, 5.6],
				]),
				speechFrameSec: 0.032,
				transcript: close,
			},
			policy({ includeNonSpeechEvents: true }),
		);
		expect(click).toHaveLength(0);
		expect(blip?.sourceStartSec).toBeCloseTo(2.68, 2);
		expect(blip?.sourceEndSec).toBeCloseTo(3.12, 2);
		expect(suggestions.filter((suggestion) => suggestion.kind === "pause")).toHaveLength(0);
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

	it("keeps a burst the cleaned detector calls speech and admits an uncertain one", () => {
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

		const spansBurst = (suggestions: ReturnType<typeof analyzeClipPauses>) =>
			suggestions.some(
				(suggestion) => suggestion.silenceStartSec < 2.7 && suggestion.silenceEndSec > 3.1,
			);
		expect(spansBurst(protectedByCleaned)).toBe(false);
		expect(spansBurst(protectedByUncertainty)).toBe(true);
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

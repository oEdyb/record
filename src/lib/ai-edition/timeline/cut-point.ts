import type { AxcutClip, AxcutWord } from "../schema";
import { speechEnvelopeCoversDuration } from "./cut-safety";
import { buildLevelFrames, quietSpans, speechSpans } from "./pause-analysis";

export type CutEdge = "out" | "in";

export interface CutPointPolicy {
	padBeforeSec: number;
	padAfterSec: number;
	sensitivity: number;
	sentenceGapSec: number;
}

export const DEFAULT_CUT_POINT_POLICY: CutPointPolicy = {
	padBeforeSec: 0.1,
	padAfterSec: 0.15,
	sensitivity: 0.5,
	sentenceGapSec: 0.8,
};

export interface CutPointInput {
	clip: AxcutClip;
	durationSec: number;
	timeSec: number;
	edge: CutEdge;
	words: AxcutWord[];
	microphonePeaks?: Float32Array | null;
	speechProbabilities?: Float32Array | null;
	speechFrameSec?: number;
}

export type CutPointMethod = "mic-level" | "speech" | "transcript";

export interface CutPointCandidate {
	edge: CutEdge;
	before: string;
	after: string;
	transcriptSec: number;
	audioSec: number;
	method: CutPointMethod;
	cutSec: number;
	distanceSec: number;
}

export interface CutPointResult {
	requestedSec: number;
	edge: CutEdge;
	chosen: CutPointCandidate | null;
	alternatives: CutPointCandidate[];
}

interface Span {
	startSec: number;
	endSec: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;
const CONTEXT_WORDS = 6;
const WORD_ONSET_SLACK_SEC = 0.08;
const INSIDE_WORD_SEC = 0.05;
/** Minimum useful audio gap; duration alone cannot establish a word boundary. */
const MIN_GAP_SEC = 0.2;

function isSentenceEnd(word: AxcutWord, next: AxcutWord | undefined, gapSec: number): boolean {
	if (SENTENCE_END.test(word.text.trim())) return true;
	return next ? next.startSec - word.endSec >= gapSec : true;
}

function context(words: AxcutWord[], from: number, to: number): string {
	return words
		.slice(Math.max(0, from), Math.max(0, to))
		.map((word) => word.text)
		.join(" ");
}

function spanContaining(spans: Span[], timeSec: number): Span | undefined {
	return spans.find((span) => span.startSec <= timeSec && timeSec < span.endSec);
}

/**
 * Where a sentence really ends or starts, for one requested cut. The transcript
 * decides which sentence boundary is meant; the microphone level then finds the
 * last sound of the sentence (or the first sound of the next one), because word
 * timings from speech-to-text drift by a few hundred milliseconds. Speech
 * detection is the fallback when the microphone track is missing.
 */
/**
 * True when a cut at `timeSec` lands inside speech: a sentence spans the cut, or the audio
 * evidence behind the adjacent-word candidate says speech continues on the removed side.
 */
export function cutInsideSentence(
	words: AxcutWord[],
	timeSec: number,
	edge: CutEdge,
	chosen: Pick<CutPointCandidate, "transcriptSec" | "cutSec">,
	gapSec: number,
): boolean {
	let index = -1;
	for (let i = 0; i < words.length && words[i].startSec < timeSec; i++) index = i;
	const word = words[index];
	if (word && !isSentenceEnd(word, words[index + 1], gapSec)) return true;
	if (edge === "out")
		return Boolean(word) && chosen.transcriptSec === word.endSec && chosen.cutSec > timeSec;
	const next = words[index + 1];
	return Boolean(next) && chosen.transcriptSec === next.startSec && chosen.cutSec < timeSec;
}

const SPEECH_MARGIN_DB = 10;
const REMOVED_WINDOW_SEC = 1.5;
const KEPT_WINDOW_SEC = 1.5;
/**
 * True when the microphone hears something near speech level on the removed side of a cut.
 * Breaths, room noise and early transcript onsets fall more than 10 dB under the kept words.
 * The kept window is long enough to reach past the air a shortened pause leaves before speech.
 */
export function removedSideHasSpeech(
	peaks: Float32Array | null | undefined,
	durationSec: number,
	edge: CutEdge,
	timeSec: number,
	chosenCutSec: number,
): boolean {
	if (!peaks || peaks.length === 0) return true;
	const frames = buildLevelFrames(peaks, durationSec);
	const loudest = (startSec: number, endSec: number) =>
		frames
			.filter((frame) => frame.endSec > startSec && frame.startSec < endSec)
			.reduce((max, frame) => Math.max(max, frame.db), Number.NEGATIVE_INFINITY);
	const removed =
		edge === "out"
			? loudest(timeSec, Math.min(chosenCutSec, timeSec + REMOVED_WINDOW_SEC))
			: loudest(Math.max(chosenCutSec, timeSec - REMOVED_WINDOW_SEC), timeSec);
	const kept =
		edge === "out"
			? loudest(timeSec - KEPT_WINDOW_SEC, timeSec)
			: loudest(timeSec, timeSec + KEPT_WINDOW_SEC);
	return removed >= kept - SPEECH_MARGIN_DB;
}

export function planCutPoint(
	input: CutPointInput,
	policy: CutPointPolicy = DEFAULT_CUT_POINT_POLICY,
): CutPointResult {
	const { clip, durationSec, timeSec, edge } = input;
	const clipStart = clip.sourceStartSec;
	const clipEnd = clip.sourceEndSec ?? durationSec;
	const words = input.words
		.filter((word) => word.sourceRole !== "system")
		.filter((word) => word.endSec > clipStart && word.startSec < clipEnd)
		.sort((left, right) => left.startSec - right.startSec);
	const empty: CutPointResult = { requestedSec: timeSec, edge, chosen: null, alternatives: [] };
	if (words.length === 0) return empty;
	const quiet = quietSpans(input.microphonePeaks, durationSec, policy.sensitivity).filter(
		(span) => span.endSec - span.startSec >= MIN_GAP_SEC,
	);
	const speech = speechEnvelopeCoversDuration(
		input.speechProbabilities,
		input.speechFrameSec,
		durationSec,
	)
		? speechSpans(input.speechProbabilities, input.speechFrameSec, durationSec, policy.sensitivity)
		: [];

	const candidates: CutPointCandidate[] = [];
	const boundaries: number[] = [];
	if (edge === "in") boundaries.push(-1);
	words.forEach((word, index) => {
		if (isSentenceEnd(word, words[index + 1], policy.sentenceGapSec)) boundaries.push(index);
	});

	for (const last of boundaries) {
		const lastWord = words[last];
		const nextWord = words[last + 1];
		if (edge === "out") {
			if (!lastWord) continue;
			const limitSec = nextWord ? nextWord.startSec : clipEnd;
			const gap = quiet.find(
				(span) =>
					span.startSec > lastWord.startSec + INSIDE_WORD_SEC &&
					span.startSec <= limitSec + 0.001 &&
					span.endSec >= lastWord.endSec,
			);
			const voice = spanContaining(speech, lastWord.startSec);
			const [audioSec, method]: [number, CutPointMethod] = gap
				? [gap.startSec, "mic-level"]
				: voice && voice.endSec >= lastWord.endSec
					? [Math.min(voice.endSec, limitSec), "speech"]
					: [lastWord.endSec, "transcript"];
			const cutSec = Math.min(
				clipEnd,
				Math.max(lastWord.startSec + INSIDE_WORD_SEC, audioSec + policy.padAfterSec),
			);
			candidates.push({
				edge,
				before: context(words, last - CONTEXT_WORDS + 1, last + 1),
				after: context(words, last + 1, last + 1 + CONTEXT_WORDS),
				transcriptSec: lastWord.endSec,
				audioSec,
				method,
				cutSec,
				distanceSec: Math.abs(lastWord.endSec - timeSec),
			});
		} else {
			if (!nextWord) continue;
			const floorSec = lastWord ? lastWord.endSec - INSIDE_WORD_SEC : clipStart;
			const gap = [...quiet]
				.reverse()
				.find(
					(span) =>
						span.endSec <= nextWord.startSec + WORD_ONSET_SLACK_SEC && span.endSec >= floorSec,
				);
			const voice = spanContaining(speech, nextWord.startSec);
			const [audioSec, method]: [number, CutPointMethod] = gap
				? [gap.endSec, "mic-level"]
				: voice
					? [Math.max(voice.startSec, floorSec), "speech"]
					: [nextWord.startSec, "transcript"];
			const cutSec = Math.max(
				clipStart,
				Math.min(nextWord.startSec, audioSec - policy.padBeforeSec),
			);
			candidates.push({
				edge,
				before: context(words, last - CONTEXT_WORDS + 1, last + 1),
				after: context(words, last + 1, last + 1 + CONTEXT_WORDS),
				transcriptSec: nextWord.startSec,
				audioSec,
				method,
				cutSec,
				distanceSec: Math.abs(nextWord.startSec - timeSec),
			});
		}
	}
	candidates.sort((left, right) => left.distanceSec - right.distanceSec);
	const [chosen, ...rest] = candidates;
	return { requestedSec: timeSec, edge, chosen: chosen ?? null, alternatives: rest.slice(0, 2) };
}

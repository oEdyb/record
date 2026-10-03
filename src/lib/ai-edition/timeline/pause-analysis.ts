import type { AxcutClip, AxcutTranscript, AxcutTrimRange } from "../schema";
import {
	speechEnvelopeCoversDuration,
	transcriptCutWindows,
	trustedTranscriptWords,
} from "./cut-safety";
import { trimAppliesToClip } from "./trim-mapping";

export type PauseDetectionMode = "speech" | "audio-level";

export interface PauseAnalysisPolicy {
	mode: PauseDetectionMode;
	minimumPauseSec: number;
	shortenedPauseSec: number;
	keepBeforeSec: number;
	keepAfterSec: number;
	minimumKeptFragmentSec: number;
	sensitivity: number;
	manualThresholdDb: number | null;
	includeNonSpeechEvents: boolean;
	protectSystemAudio: boolean;
	protectScreenActivity: boolean;
	transitionMs: number;
}

export interface PauseProtectionSpan {
	startSec: number;
	endSec: number;
}

export interface PauseAnalysisInput {
	clip: AxcutClip;
	durationSec: number;
	microphonePeaks: Float32Array;
	speechProbabilities?: Float32Array | null;
	cleanedSpeechProbabilities?: Float32Array | null;
	speechFrameSec?: number;
	systemPeaks?: Float32Array | null;
	transcript?: AxcutTranscript | null;
	screenActivity?: PauseProtectionSpan[];
	existingTrims?: AxcutTrimRange[];
}

export interface PauseSuggestion {
	id: string;
	/** "pause" shortens dead air; "blip" removes a wordless sound such as a cough inside a sentence. */
	kind: "pause" | "blip";
	clipId: string;
	assetId: string;
	silenceStartSec: number;
	silenceEndSec: number;
	sourceStartSec: number;
	sourceEndSec: number;
	timelineStartSec: number;
	timelineEndSec: number;
	savedSec: number;
}

export const PAUSE_PRESETS = {
	natural: {
		minimumPauseSec: 1.2,
		shortenedPauseSec: 0.45,
	},
	balanced: {
		minimumPauseSec: 0.8,
		shortenedPauseSec: 0.3,
	},
	tight: {
		minimumPauseSec: 0.55,
		shortenedPauseSec: 0.18,
	},
} as const;

export type PausePresetId = keyof typeof PAUSE_PRESETS;

export const DEFAULT_PAUSE_POLICY: PauseAnalysisPolicy = {
	mode: "speech",
	...PAUSE_PRESETS.balanced,
	keepBeforeSec: 0.12,
	keepAfterSec: 0.18,
	minimumKeptFragmentSec: 0.35,
	sensitivity: 0.5,
	manualThresholdDb: null,
	includeNonSpeechEvents: true,
	protectSystemAudio: true,
	protectScreenActivity: true,
	transitionMs: 10,
};

const FRAME_SEC = 0.02;
const HYSTERESIS_DB = 4;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function quantile(values: number[], fraction: number): number {
	if (values.length === 0) return -96;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor((sorted.length - 1) * clamp(fraction, 0, 1))] ?? -96;
}

function amplitudeToDb(amplitude: number): number {
	return 20 * Math.log10(Math.max(0.000_001, amplitude));
}

/**
 * Convert cached min/max waveform blocks into a stable 20 ms activity envelope.
 * The detector does not need decoded PCM in the renderer, and the native peak cache
 * keeps repeated policy changes fast.
 */
export function buildLevelFrames(
	peaks: Float32Array,
	durationSec: number,
): Array<{ startSec: number; endSec: number; db: number }> {
	const blockCount = Math.floor(peaks.length / 2);
	if (blockCount === 0 || durationSec <= 0) return [];
	const blockSec = durationSec / blockCount;
	const blocksPerFrame = Math.max(1, Math.round(FRAME_SEC / blockSec));
	const frames: Array<{ startSec: number; endSec: number; db: number }> = [];
	for (let block = 0; block < blockCount; block += blocksPerFrame) {
		const endBlock = Math.min(blockCount, block + blocksPerFrame);
		let power = 0;
		for (let index = block; index < endBlock; index += 1) {
			const amplitude = Math.max(
				Math.abs(peaks[index * 2] ?? 0),
				Math.abs(peaks[index * 2 + 1] ?? 0),
			);
			power += amplitude * amplitude;
		}
		frames.push({
			startSec: block * blockSec,
			endSec: endBlock * blockSec,
			db: amplitudeToDb(Math.sqrt(power / Math.max(1, endBlock - block))),
		});
	}
	return frames;
}

export function adaptiveSilenceThresholdDb(
	frames: Array<{ db: number }>,
	sensitivity: number,
): number {
	const noiseFloor = quantile(
		frames.map((frame) => frame.db),
		0.2,
	);
	const marginDb = 6 + clamp(sensitivity, 0, 1) * 8;
	return clamp(noiseFloor + marginDb, -52, -26);
}

function overlaps(left: PauseProtectionSpan, right: PauseProtectionSpan): boolean {
	return left.endSec > right.startSec && left.startSec < right.endSec;
}

function mergeSpans(spans: PauseProtectionSpan[], maximumGapSec = 0.001): PauseProtectionSpan[] {
	const sorted = spans
		.filter((span) => span.endSec > span.startSec)
		.sort((left, right) => left.startSec - right.startSec);
	const merged: PauseProtectionSpan[] = [];
	for (const span of sorted) {
		const current = merged.at(-1);
		if (current && span.startSec <= current.endSec + maximumGapSec) {
			current.endSec = Math.max(current.endSec, span.endSec);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

/** Speech islands from a Silero envelope, with the planner's own margins and dip bridging. */
export function speechSpans(
	probabilities: Float32Array | null | undefined,
	frameSec: number | undefined,
	durationSec: number,
	sensitivity: number,
): PauseProtectionSpan[] {
	return speechProbabilityProtection(probabilities, frameSec, durationSec, sensitivity);
}

/** Quiet stretches of the microphone envelope, with the planner's own adaptive threshold and hysteresis. */
export function quietSpans(
	peaks: Float32Array | null | undefined,
	durationSec: number,
	sensitivity: number,
): PauseProtectionSpan[] {
	if (!peaks || peaks.length === 0) return [];
	const frames = buildLevelFrames(peaks, durationSec);
	return quietSpansFromFrames(frames, adaptiveSilenceThresholdDb(frames, sensitivity), []);
}

function speechProbabilityProtection(
	probabilities: Float32Array | null | undefined,
	frameSec: number | undefined,
	durationSec: number,
	sensitivity: number,
): PauseProtectionSpan[] {
	if (!probabilities || probabilities.length === 0) return [];
	const stepSec = frameSec && frameSec > 0 ? frameSec : durationSec / probabilities.length;
	const threshold = 0.65 - clamp(sensitivity, 0, 1) * 0.3;
	const raw = Array.from(probabilities).flatMap((probability, index): PauseProtectionSpan[] =>
		probability >= threshold
			? [
					{
						startSec: Math.max(0, index * stepSec - 0.04),
						endSec: Math.min(durationSec, (index + 1) * stepSec + 0.04),
					},
				]
			: [],
	);
	// Silero frames are 32 ms. Bridge sub-120 ms probability dips so one word
	// does not turn into several speech islands and expose an unsafe micro-cut.
	return mergeSpans(raw, 0.12);
}

function existingTrimProtection(trims: AxcutTrimRange[], clip: AxcutClip): PauseProtectionSpan[] {
	return trims
		.filter((trim) => trimAppliesToClip(trim, clip))
		.map((trim) => ({ startSec: trim.startSec, endSec: trim.endSec }));
}

function firstSpanEndingAfter(spans: PauseProtectionSpan[], timeSec: number): number {
	let left = 0;
	let right = spans.length;
	while (left < right) {
		const middle = Math.floor((left + right) / 2);
		if (spans[middle].endSec <= timeSec) left = middle + 1;
		else right = middle;
	}
	return left;
}

function overlappingSpans(
	spans: PauseProtectionSpan[],
	window: PauseProtectionSpan,
): PauseProtectionSpan[] {
	const start = firstSpanEndingAfter(spans, window.startSec);
	let end = start;
	while (end < spans.length && spans[end].startSec < window.endSec) end += 1;
	return spans.slice(start, end);
}

function frameIsProtected(frame: PauseProtectionSpan, blockers: PauseProtectionSpan[]): boolean {
	const blocker = blockers[firstSpanEndingAfter(blockers, frame.startSec)];
	return Boolean(blocker && overlaps(frame, blocker));
}

function quietSpansFromFrames(
	frames: Array<{ startSec: number; endSec: number; db: number }>,
	thresholdDb: number,
	blockers: PauseProtectionSpan[],
): PauseProtectionSpan[] {
	const spans: PauseProtectionSpan[] = [];
	let quiet = false;
	let startSec = 0;
	let blockerIndex = firstSpanEndingAfter(blockers, frames[0]?.startSec ?? 0);
	for (const frame of frames) {
		while (blockerIndex < blockers.length && blockers[blockerIndex].endSec <= frame.startSec)
			blockerIndex += 1;
		const blocker = blockers[blockerIndex];
		const protectedFrame = Boolean(blocker && overlaps(frame, blocker));
		const nextQuiet: boolean =
			!protectedFrame && frame.db < thresholdDb + (quiet ? HYSTERESIS_DB : 0);
		if (nextQuiet && !quiet) startSec = frame.startSec;
		if (!nextQuiet && quiet) spans.push({ startSec, endSec: frame.startSec });
		quiet = nextQuiet;
	}
	if (quiet && frames.length > 0) {
		spans.push({ startSec, endSec: frames.at(-1)?.endSec ?? startSec });
	}
	return spans;
}

function peakProtection(
	peaks: Float32Array | null | undefined,
	durationSec: number,
	sensitivity: number,
): PauseProtectionSpan[] {
	if (!peaks || peaks.length === 0) return [];
	const frames = buildLevelFrames(peaks, durationSec);
	const threshold = adaptiveSilenceThresholdDb(frames, sensitivity);
	return mergeSpans(
		frames
			.filter((frame) => frame.db >= threshold)
			.map((frame) => ({ startSec: frame.startSec, endSec: frame.endSec })),
	);
}

function maximumProbabilityInSpan(
	probabilities: Float32Array,
	frameSec: number,
	span: PauseProtectionSpan,
	padSec = 0.08,
): number | null {
	const paddedStartSec = Math.max(0, span.startSec - padSec);
	const paddedEndSec = span.endSec + padSec;
	const coverageEndSec = probabilities.length * frameSec;
	if (paddedEndSec > coverageEndSec + 0.000_001) return null;
	const startIndex = Math.max(0, Math.floor(paddedStartSec / frameSec));
	const endIndex = Math.min(probabilities.length, Math.ceil(paddedEndSec / frameSec));
	if (endIndex <= startIndex) return null;
	let maximum = 0;
	for (let index = startIndex; index < endIndex; index += 1) {
		maximum = Math.max(maximum, probabilities[index] ?? 0);
	}
	return maximum;
}

const BLIP_MAX_SEC = 0.5;
const BLIP_SPEECH_CEILING = 0.8;
const BLIP_MARGIN_SEC = 0.02;
const BLIP_PROPOSAL_MIN_SEC = 0.15;
const BLIP_PROPOSAL_JOIN_SEC = 0.1;
const BLIP_WORD_CLEARANCE_SEC = 0.04;

/**
 * A wordless blip is a short microphone sound (cough, click, breath, key press) that the
 * transcript did not hear as a word and the speech detector is not sure about. It is part of
 * the pause around it, and inside a sentence it is a removal candidate of its own.
 */
function wordlessBlips(
	input: PauseAnalysisInput,
	activity: PauseProtectionSpan[],
	speechProtection: PauseProtectionSpan[],
	wordProtection: PauseProtectionSpan[],
): PauseProtectionSpan[] {
	const frameSec = input.speechFrameSec;
	const detectors = [input.speechProbabilities, input.cleanedSpeechProbabilities].filter(
		(value): value is Float32Array => Boolean(value && value.length > 0),
	);
	return mergeSpans([...activity, ...speechProtection]).filter((span) => {
		if (span.endSec - span.startSec > BLIP_MAX_SEC) return false;
		if (frameIsProtected(span, wordProtection)) return false;
		if (!frameSec || frameSec <= 0) return detectors.length === 0;
		return detectors.every((probabilities) => {
			const maximum = maximumProbabilityInSpan(probabilities, frameSec, span, 0);
			return maximum !== null && maximum < BLIP_SPEECH_CEILING;
		});
	});
}

/**
 * The speech envelope stays on for about half a second after a word, so a speech-mode pause
 * starts late. Walk its edges outward over microphone frames that are quiet or inside a wordless
 * blip, stopping at any word, system, screen or trim protection.
 */
function widenToMicrophoneEdges(
	span: PauseProtectionSpan,
	frames: Array<{ startSec: number; endSec: number; db: number }>,
	thresholdDb: number,
	blips: PauseProtectionSpan[],
	environment: PauseProtectionSpan[],
): PauseProtectionSpan {
	const silent = (frame: { startSec: number; endSec: number; db: number }) =>
		(frame.db < thresholdDb || frameIsProtected(frame, blips)) &&
		!frameIsProtected(frame, environment);
	let startSec = span.startSec;
	for (let index = frames.length - 1; index >= 0; index -= 1) {
		const frame = frames[index];
		if (frame.endSec > startSec + 0.001) continue;
		if (frame.endSec < startSec - 0.001 || !silent(frame)) break;
		startSec = frame.startSec;
	}
	let endSec = span.endSec;
	for (const frame of frames) {
		if (frame.startSec < endSec - 0.001) continue;
		if (frame.startSec > endSec + 0.001 || !silent(frame)) break;
		endSec = frame.endSec;
	}
	return { startSec, endSec };
}

function insideAny(span: PauseProtectionSpan, spans: PauseProtectionSpan[]): boolean {
	const outer = spans[firstSpanEndingAfter(spans, span.startSec - 0.001)];
	return Boolean(
		outer && span.startSec >= outer.startSec - 0.001 && span.endSec <= outer.endSec + 0.001,
	);
}

const EDGE_EPSILON_SEC = 0.001;

function stableSuggestionId(clipId: string, startSec: number, endSec: number): string {
	return `pause_${clipId}_${Math.round(startSec * 1_000)}_${Math.round(endSec * 1_000)}`;
}

/**
 * Find removable middles of quiet spans for one raw clip. All returned times are
 * source-time except the two timeline fields. The accepted edit can therefore be
 * stored as an ordinary clip-anchored trim range.
 */
export function analyzeClipPauses(
	input: PauseAnalysisInput,
	policy: PauseAnalysisPolicy = DEFAULT_PAUSE_POLICY,
): PauseSuggestion[] {
	const { clip, durationSec } = input;
	const clipSourceEndSec = clip.sourceEndSec ?? durationSec;
	if (clipSourceEndSec <= clip.sourceStartSec || input.microphonePeaks.length === 0) return [];
	if (
		policy.mode === "speech" &&
		(!speechEnvelopeCoversDuration(input.speechProbabilities, input.speechFrameSec, durationSec) ||
			(input.cleanedSpeechProbabilities &&
				!speechEnvelopeCoversDuration(
					input.cleanedSpeechProbabilities,
					input.speechFrameSec,
					durationSec,
				)))
	)
		return [];

	const frames = buildLevelFrames(input.microphonePeaks, durationSec).filter(
		(frame) => frame.endSec > clip.sourceStartSec && frame.startSec < clipSourceEndSec,
	);
	if (frames.length === 0) return [];
	const thresholdDb =
		policy.manualThresholdDb ?? adaptiveSilenceThresholdDb(frames, policy.sensitivity);
	const rawSpeechProtection =
		policy.mode === "speech"
			? speechProbabilityProtection(
					input.speechProbabilities,
					input.speechFrameSec,
					durationSec,
					policy.sensitivity,
				)
			: [];
	const cleanedSpeechProtection =
		policy.mode === "speech"
			? speechProbabilityProtection(
					input.cleanedSpeechProbabilities,
					input.speechFrameSec,
					durationSec,
					policy.sensitivity,
				)
			: [];
	const speechProtection = mergeSpans([...rawSpeechProtection, ...cleanedSpeechProtection]);
	const words = trustedTranscriptWords(input.transcript, clip, durationSec);
	const windows = transcriptCutWindows(words, clip, durationSec, policy.minimumPauseSec);
	const wordProtection =
		policy.mode === "speech"
			? mergeSpans(
					words.map((word) => ({
						startSec: Math.max(clip.sourceStartSec, word.startSec - 0.08),
						endSec: Math.min(clipSourceEndSec, word.endSec + 0.12),
					})),
				)
			: [];
	const activity =
		policy.mode === "speech"
			? peakProtection(input.microphonePeaks, input.durationSec, policy.sensitivity)
			: [];
	const boundedWindows = windows.filter((window) => window.bounded);
	const blips =
		policy.mode === "speech" && policy.includeNonSpeechEvents
			? wordlessBlips(input, activity, speechProtection, wordProtection).filter((span) =>
					insideAny(span, boundedWindows),
				)
			: [];
	const environment = mergeSpans([
		...wordProtection,
		...(policy.protectSystemAudio
			? peakProtection(input.systemPeaks, durationSec, policy.sensitivity)
			: []),
		...(policy.protectScreenActivity ? (input.screenActivity ?? []) : []),
		...existingTrimProtection(input.existingTrims ?? [], clip),
	]);
	const boundedBlockers = mergeSpans([
		...speechProtection.filter((span) => !insideAny(span, blips)),
		...activity.filter((span) => !insideAny(span, blips)),
		...environment,
	]);
	const unboundedBlockers = mergeSpans([...speechProtection, ...activity, ...environment]);
	let frameIndex = 0;
	const quietSpans =
		policy.mode === "speech"
			? windows
					.filter((window) => window.pauseAllowed)
					.flatMap((window) => {
						while (frameIndex < frames.length && frames[frameIndex].endSec <= window.startSec)
							frameIndex += 1;
						const firstFrame = frameIndex;
						while (frameIndex < frames.length && frames[frameIndex].startSec < window.endSec)
							frameIndex += 1;
						const windowFrames = frames.slice(firstFrame, frameIndex).map((frame) => ({
							...frame,
							startSec: Math.max(frame.startSec, window.startSec),
							endSec: Math.min(frame.endSec, window.endSec),
						}));
						if (frameIndex > firstFrame && frames[frameIndex - 1].endSec > window.endSec)
							frameIndex -= 1;
						const permittedBlips = window.bounded ? overlappingSpans(blips, window) : [];
						const wideningBlockers = mergeSpans([
							...overlappingSpans(environment, window),
							...overlappingSpans(speechProtection, window).filter(
								(speech) =>
									speech.startSec > window.startSec &&
									speech.endSec < window.endSec &&
									!insideAny(speech, permittedBlips),
							),
						]);
						return quietSpansFromFrames(
							windowFrames.map((frame) => ({ ...frame, db: -96 })),
							thresholdDb,
							window.bounded ? boundedBlockers : unboundedBlockers,
						).map((span) =>
							window.bounded
								? widenToMicrophoneEdges(
										span,
										windowFrames,
										thresholdDb,
										permittedBlips,
										wideningBlockers,
									)
								: span,
						);
					})
			: quietSpansFromFrames(frames, thresholdDb, environment);
	const minimumRetainedSec = Math.max(
		policy.shortenedPauseSec,
		policy.keepBeforeSec + policy.keepAfterSec,
	);

	const proposals = quietSpans.flatMap((span): PauseSuggestion[] => {
		const silenceStartSec = Math.max(clip.sourceStartSec, span.startSec);
		const silenceEndSec = Math.min(clipSourceEndSec, span.endSec);
		const silenceDurationSec = silenceEndSec - silenceStartSec;
		const touchesClipStart = silenceStartSec <= clip.sourceStartSec + EDGE_EPSILON_SEC;
		const touchesClipEnd = silenceEndSec >= clipSourceEndSec - EDGE_EPSILON_SEC;
		if (touchesClipStart && touchesClipEnd) return [];
		const retainedSec = touchesClipStart
			? policy.keepBeforeSec
			: touchesClipEnd
				? policy.keepAfterSec
				: minimumRetainedSec;
		if (silenceDurationSec < policy.minimumPauseSec || silenceDurationSec <= retainedSec) {
			return [];
		}
		const extraRetainedSec =
			touchesClipStart || touchesClipEnd
				? 0
				: minimumRetainedSec - policy.keepBeforeSec - policy.keepAfterSec;
		const sourceStartSec = touchesClipStart
			? silenceStartSec
			: silenceStartSec + policy.keepAfterSec + extraRetainedSec / 2;
		const sourceEndSec = touchesClipEnd
			? silenceEndSec
			: silenceEndSec - policy.keepBeforeSec - extraRetainedSec / 2;
		if (sourceEndSec - sourceStartSec < 0.04) return [];
		const timelineStartSec = clip.timelineStartSec + (sourceStartSec - clip.sourceStartSec);
		const timelineEndSec = clip.timelineStartSec + (sourceEndSec - clip.sourceStartSec);
		return [
			{
				id: stableSuggestionId(clip.id, sourceStartSec, sourceEndSec),
				kind: "pause",
				clipId: clip.id,
				assetId: clip.assetId,
				silenceStartSec,
				silenceEndSec,
				sourceStartSec,
				sourceEndSec,
				timelineStartSec,
				timelineEndSec,
				savedSec: sourceEndSec - sourceStartSec,
			},
		];
	});
	const protectedWords = wordProtection.filter((word) => word.endSec > clip.sourceStartSec);
	const blipProposals = mergeSpans(blips, BLIP_PROPOSAL_JOIN_SEC).flatMap(
		(blip): PauseSuggestion[] => {
			if (blip.endSec - blip.startSec < BLIP_PROPOSAL_MIN_SEC) return [];
			if (frameIsProtected(blip, environment)) return [];
			if (
				proposals.some(
					(proposal) =>
						blip.endSec > proposal.silenceStartSec && blip.startSec < proposal.silenceEndSec,
				)
			)
				return [];
			const previousWordEnd = Math.max(
				clip.sourceStartSec,
				...protectedWords
					.filter((word) => word.endSec <= blip.startSec + 0.001)
					.map((word) => word.endSec),
			);
			const nextWordStart = Math.min(
				clipSourceEndSec,
				...protectedWords
					.filter((word) => word.startSec >= blip.endSec - 0.001)
					.map((word) => word.startSec),
			);
			const sourceStartSec = Math.max(
				previousWordEnd + BLIP_WORD_CLEARANCE_SEC,
				blip.startSec - BLIP_MARGIN_SEC,
			);
			const sourceEndSec = Math.min(
				nextWordStart - BLIP_WORD_CLEARANCE_SEC,
				blip.endSec + BLIP_MARGIN_SEC,
			);
			if (sourceEndSec - sourceStartSec < 0.04) return [];
			return [
				{
					id: stableSuggestionId(clip.id, sourceStartSec, sourceEndSec),
					kind: "blip",
					clipId: clip.id,
					assetId: clip.assetId,
					silenceStartSec: blip.startSec,
					silenceEndSec: blip.endSec,
					sourceStartSec,
					sourceEndSec,
					timelineStartSec: clip.timelineStartSec + (sourceStartSec - clip.sourceStartSec),
					timelineEndSec: clip.timelineStartSec + (sourceEndSec - clip.sourceStartSec),
					savedSec: sourceEndSec - sourceStartSec,
				},
			];
		},
	);
	const accepted: PauseSuggestion[] = [];
	let previousCutEndSec = clip.sourceStartSec;
	for (const proposal of [...proposals, ...blipProposals].sort(
		(left, right) => left.sourceStartSec - right.sourceStartSec,
	)) {
		const keptBeforeSec = proposal.sourceStartSec - previousCutEndSec;
		const keptAfterSec = clipSourceEndSec - proposal.sourceEndSec;
		if (keptBeforeSec > 0 && keptBeforeSec < policy.minimumKeptFragmentSec) continue;
		if (keptAfterSec > 0 && keptAfterSec < policy.minimumKeptFragmentSec) continue;
		accepted.push(proposal);
		previousCutEndSec = proposal.sourceEndSec;
	}
	return accepted;
}

import type { AxcutClip, AxcutTranscript, AxcutTrimRange } from "../schema";
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
	nonSpeechMaximumProbability: number;
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
	includeNonSpeechEvents: false,
	nonSpeechMaximumProbability: 0.18,
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
	return mergeSpans(raw, 0.12).filter((span) => span.endSec - span.startSec >= 0.08);
}

function speechEnvelopeCoversDuration(
	probabilities: Float32Array | null | undefined,
	frameSec: number | undefined,
	durationSec: number,
): boolean {
	return Boolean(
		probabilities &&
			probabilities.length > 0 &&
			frameSec &&
			frameSec > 0 &&
			probabilities.length * frameSec + frameSec >= durationSec,
	);
}

function transcriptProtection(
	transcript: AxcutTranscript | null | undefined,
	clip: AxcutClip,
): PauseProtectionSpan[] {
	if (!transcript || transcript.assetId !== clip.assetId) return [];
	return transcript.words.map((word) => ({
		startSec: Math.max(clip.sourceStartSec, word.startSec - 0.08),
		endSec: Math.min(clip.sourceEndSec ?? word.endSec, word.endSec + 0.12),
	}));
}

function existingTrimProtection(trims: AxcutTrimRange[], clip: AxcutClip): PauseProtectionSpan[] {
	return trims
		.filter((trim) => trimAppliesToClip(trim, clip))
		.map((trim) => ({ startSec: trim.startSec, endSec: trim.endSec }));
}

function frameIsProtected(frame: PauseProtectionSpan, blockers: PauseProtectionSpan[]): boolean {
	return blockers.some((blocker) => overlaps(frame, blocker));
}

function quietSpansFromFrames(
	frames: Array<{ startSec: number; endSec: number; db: number }>,
	thresholdDb: number,
	blockers: PauseProtectionSpan[],
): PauseProtectionSpan[] {
	const spans: PauseProtectionSpan[] = [];
	let quiet = false;
	let startSec = 0;
	for (const frame of frames) {
		const protectedFrame = frameIsProtected(frame, blockers);
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
): number | null {
	const paddedStartSec = Math.max(0, span.startSec - 0.08);
	const paddedEndSec = span.endSec + 0.08;
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

function microphoneProtection(
	input: PauseAnalysisInput,
	policy: PauseAnalysisPolicy,
	speechProtection: PauseProtectionSpan[],
	wordProtection: PauseProtectionSpan[],
): PauseProtectionSpan[] {
	const activity = peakProtection(input.microphonePeaks, input.durationSec, policy.sensitivity);
	const raw = input.speechProbabilities;
	const cleaned = input.cleanedSpeechProbabilities;
	const frameSec = input.speechFrameSec;
	if (!policy.includeNonSpeechEvents || !raw || !cleaned || !frameSec || frameSec <= 0) {
		return activity;
	}
	const knownSpeech = [...speechProtection, ...wordProtection];
	return activity.filter((span) => {
		if (frameIsProtected(span, knownSpeech)) return true;
		// A raw energy spike is removable only when two views of the same mic
		// agree with high confidence that it is not speech. This admits common
		// isolated non-speech sounds into the surrounding pause without treating the
		// denoised signal as a standalone cut authority.
		const rawMaximum = maximumProbabilityInSpan(raw, frameSec, span);
		const cleanedMaximum = maximumProbabilityInSpan(cleaned, frameSec, span);
		return (
			rawMaximum === null ||
			cleanedMaximum === null ||
			rawMaximum > policy.nonSpeechMaximumProbability ||
			cleanedMaximum > policy.nonSpeechMaximumProbability
		);
	});
}

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
	const wordProtection =
		policy.mode === "speech" ? transcriptProtection(input.transcript, clip) : [];
	const blockers = mergeSpans([
		...speechProtection,
		...wordProtection,
		...(policy.mode === "speech"
			? microphoneProtection(input, policy, speechProtection, wordProtection)
			: []),
		...(policy.protectSystemAudio
			? peakProtection(input.systemPeaks, durationSec, policy.sensitivity)
			: []),
		...(policy.protectScreenActivity ? (input.screenActivity ?? []) : []),
		...existingTrimProtection(input.existingTrims ?? [], clip),
	]);
	const quietSpans = quietSpansFromFrames(
		policy.mode === "speech" ? frames.map((frame) => ({ ...frame, db: -96 })) : frames,
		thresholdDb,
		blockers,
	);
	const minimumRetainedSec = Math.max(
		policy.shortenedPauseSec,
		policy.keepBeforeSec + policy.keepAfterSec,
	);

	const proposals = quietSpans.flatMap((span): PauseSuggestion[] => {
		const silenceStartSec = Math.max(clip.sourceStartSec, span.startSec);
		const silenceEndSec = Math.min(clipSourceEndSec, span.endSec);
		const silenceDurationSec = silenceEndSec - silenceStartSec;
		if (silenceDurationSec < policy.minimumPauseSec || silenceDurationSec <= minimumRetainedSec) {
			return [];
		}
		const extraRetainedSec = minimumRetainedSec - policy.keepBeforeSec - policy.keepAfterSec;
		const sourceStartSec = silenceStartSec + policy.keepAfterSec + extraRetainedSec / 2;
		const sourceEndSec = silenceEndSec - policy.keepBeforeSec - extraRetainedSec / 2;
		if (sourceEndSec - sourceStartSec < 0.04) return [];
		const timelineStartSec = clip.timelineStartSec + (sourceStartSec - clip.sourceStartSec);
		const timelineEndSec = clip.timelineStartSec + (sourceEndSec - clip.sourceStartSec);
		return [
			{
				id: stableSuggestionId(clip.id, sourceStartSec, sourceEndSec),
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
	const accepted: PauseSuggestion[] = [];
	let previousCutEndSec = clip.sourceStartSec;
	for (const proposal of proposals) {
		if (proposal.sourceStartSec - previousCutEndSec < policy.minimumKeptFragmentSec) continue;
		if (clipSourceEndSec - proposal.sourceEndSec < policy.minimumKeptFragmentSec) continue;
		accepted.push(proposal);
		previousCutEndSec = proposal.sourceEndSec;
	}
	return accepted;
}

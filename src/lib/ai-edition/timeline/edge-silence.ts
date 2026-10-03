import type { AxcutClip, AxcutTranscript, AxcutTrimRange } from "../schema";
import { speechEnvelopeCoversDuration, trustedTranscriptWords } from "./cut-safety";
import { analyzeClipPauses, DEFAULT_PAUSE_POLICY, speechSpans } from "./pause-analysis";

export const EDGE_TRIM_REASON = "edge-silence";
export const GAP_TRIM_REASON = "gap-silence";

export function isDeadAirTrim(trim: Pick<AxcutTrimRange, "reason">): boolean {
	return trim.reason === EDGE_TRIM_REASON || trim.reason === GAP_TRIM_REASON;
}

export interface EdgeSilencePolicy {
	padBeforeSec: number;
	padAfterSec: number;
	sensitivity: number;
	minimumCutSec: number;
	maximumClipSec: number;
	minimumGapSec: number;
}

export const DEFAULT_EDGE_SILENCE_POLICY: EdgeSilencePolicy = {
	padBeforeSec: 0.1,
	padAfterSec: 0.15,
	sensitivity: 0.5,
	minimumCutSec: 0.05,
	maximumClipSec: 120,
	minimumGapSec: 1,
};

export interface EdgeSilenceInput {
	clip: AxcutClip;
	durationSec: number;
	speechProbabilities: Float32Array | null | undefined;
	speechFrameSec: number | undefined;
	microphonePeaks?: Float32Array | null;
	cleanedSpeechProbabilities?: Float32Array | null;
	transcript?: AxcutTranscript | null;
	existingTrims?: AxcutTrimRange[];
}

export type EdgeSilenceKind = "lead" | "tail" | "gap";

export interface EdgeSilenceSuggestion {
	clipId: string;
	edge: EdgeSilenceKind;
	reason: string;
	sourceStartSec: number;
	sourceEndSec: number;
	savedSec: number;
}

interface Span {
	startSec: number;
	endSec: number;
}

function overlaps(left: Span, right: Span): boolean {
	return left.endSec > right.startSec && left.startSec < right.endSec;
}

function touchesEdge(trims: AxcutTrimRange[], clip: AxcutClip, edge: "lead" | "tail"): boolean {
	const clipEndSec = clip.sourceEndSec ?? Number.POSITIVE_INFINITY;
	return trims.some(
		(trim) =>
			trim.clipId === clip.id &&
			(edge === "lead"
				? trim.startSec <= clip.sourceStartSec + 0.001
				: trim.endSec >= clipEndSec - 0.001),
	);
}

function suggestion(
	clip: AxcutClip,
	edge: EdgeSilenceKind,
	sourceStartSec: number,
	sourceEndSec: number,
): EdgeSilenceSuggestion {
	return {
		clipId: clip.id,
		edge,
		reason: edge === "gap" ? GAP_TRIM_REASON : EDGE_TRIM_REASON,
		sourceStartSec,
		sourceEndSec,
		savedSec: sourceEndSec - sourceStartSec,
	};
}

function planEdges(input: EdgeSilenceInput, policy: EdgeSilencePolicy): EdgeSilenceSuggestion[] {
	const { clip, durationSec } = input;
	const clipEndSec = clip.sourceEndSec ?? durationSec;
	const spans = [input.speechProbabilities, input.cleanedSpeechProbabilities]
		.flatMap((envelope) =>
			speechSpans(envelope, input.speechFrameSec, durationSec, policy.sensitivity),
		)
		.concat(trustedTranscriptWords(input.transcript, clip, durationSec))
		.filter((span) => span.endSec > clip.sourceStartSec && span.startSec < clipEndSec);
	if (spans.length === 0) return [];
	const trims = input.existingTrims ?? [];
	const out: EdgeSilenceSuggestion[] = [];
	const firstSpeechSec = Math.max(
		clip.sourceStartSec,
		Math.min(...spans.map((span) => span.startSec)),
	);
	const leadEndSec = firstSpeechSec - policy.padBeforeSec;
	if (leadEndSec - clip.sourceStartSec >= policy.minimumCutSec && !touchesEdge(trims, clip, "lead"))
		out.push(suggestion(clip, "lead", clip.sourceStartSec, leadEndSec));
	const lastSpeechSec = Math.min(clipEndSec, Math.max(...spans.map((span) => span.endSec)));
	const tailStartSec = lastSpeechSec + policy.padAfterSec;
	if (clipEndSec - tailStartSec >= policy.minimumCutSec && !touchesEdge(trims, clip, "tail"))
		out.push(suggestion(clip, "tail", tailStartSec, clipEndSec));
	return out;
}

function planGaps(
	input: EdgeSilenceInput,
	policy: EdgeSilencePolicy,
	edges: EdgeSilenceSuggestion[],
): EdgeSilenceSuggestion[] {
	if (policy.minimumGapSec <= 0) return [];
	const { clip, durationSec } = input;
	const clipEndSec = clip.sourceEndSec ?? durationSec;
	const blockers: Span[] = [
		...(input.existingTrims ?? []).filter((trim) => trim.clipId === clip.id),
		...edges.map((edge) => ({ startSec: edge.sourceStartSec, endSec: edge.sourceEndSec })),
	];
	return analyzeClipPauses(
		{ ...input, microphonePeaks: input.microphonePeaks ?? new Float32Array() },
		{
			...DEFAULT_PAUSE_POLICY,
			minimumPauseSec: policy.minimumGapSec,
			shortenedPauseSec: policy.padAfterSec + policy.padBeforeSec,
			keepBeforeSec: policy.padBeforeSec,
			keepAfterSec: policy.padAfterSec,
			minimumKeptFragmentSec: 0,
			sensitivity: policy.sensitivity,
			includeNonSpeechEvents: false,
		},
	).flatMap((span) => {
		if (
			span.silenceStartSec <= clip.sourceStartSec + 0.001 ||
			span.silenceEndSec >= clipEndSec - 0.001
		)
			return [];
		const startSec = span.sourceStartSec;
		const endSec = span.sourceEndSec;
		if (endSec - startSec < policy.minimumCutSec) return [];
		if (blockers.some((blocker) => overlaps(blocker, { startSec, endSec }))) return [];
		return [suggestion(clip, "gap", startSec, endSec)];
	});
}

/**
 * Dead air in one take: the lead-in before the first word, the tail after the
 * last word, and quiet gaps inside the take that are long enough to feel like
 * a hole. Short pauses between words are never touched.
 */
export function planEdgeSilence(
	input: EdgeSilenceInput,
	policy: EdgeSilencePolicy = DEFAULT_EDGE_SILENCE_POLICY,
): EdgeSilenceSuggestion[] {
	const { clip, durationSec } = input;
	const clipEndSec = clip.sourceEndSec ?? durationSec;
	const clipLengthSec = clipEndSec - clip.sourceStartSec;
	if (clipLengthSec <= 0 || clipLengthSec > policy.maximumClipSec) return [];
	if (
		!speechEnvelopeCoversDuration(input.speechProbabilities, input.speechFrameSec, durationSec) ||
		(input.cleanedSpeechProbabilities &&
			!speechEnvelopeCoversDuration(
				input.cleanedSpeechProbabilities,
				input.speechFrameSec,
				durationSec,
			))
	)
		return [];
	const edges = planEdges(input, policy);
	return [...edges, ...planGaps(input, policy, edges)].sort(
		(left, right) => left.sourceStartSec - right.sourceStartSec,
	);
}

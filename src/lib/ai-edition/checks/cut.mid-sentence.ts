import type { AxcutWord } from "../schema";
import {
	cutInsideSentence,
	DEFAULT_CUT_POINT_POLICY,
	planCutPoint,
	removedSideHasSpeech,
} from "../timeline/cut-point";
import { speechEnvelopeCoversDuration } from "../timeline/cut-safety";
import { speechSpans } from "../timeline/pause-analysis";
import type { AudioObservation, ResolvedEdit } from "./context";
import { cutTrimFixes } from "./cutTrimFix";
import { type CheckRule, type Finding, finding } from "./types";

const WORDLESS_REMOVAL_MAX_SEC = 1;

/** Word absence alone cannot distinguish a blip from missed speech. */
function removesOnlyWordlessSound(
	cut: ResolvedEdit["cuts"][number],
	words: readonly AxcutWord[],
	audio: AudioObservation | undefined,
	durationSec: number | undefined,
): boolean {
	if (cut.left.assetId !== cut.right.assetId || cut.left.clip !== cut.right.clip) return false;
	const startSec = cut.left.source.endSec;
	const endSec = cut.right.source.startSec;
	if (endSec <= startSec || endSec - startSec > WORDLESS_REMOVAL_MAX_SEC) return false;
	if (
		!durationSec ||
		!speechEnvelopeCoversDuration(audio?.speechProbabilities, audio?.speechFrameSec, durationSec)
	)
		return false;
	const localWords = words.filter((word) => word.sourceRole === "you");
	if (
		!localWords.some((word) => word.endSec <= startSec && word.endSec > cut.left.source.startSec) ||
		!localWords.some((word) => word.startSec >= endSec && word.startSec < cut.right.source.endSec)
	)
		return false;
	return (
		!words.some((word) => word.startSec < endSec && word.endSec > startSec) &&
		!speechSpans(
			audio?.speechProbabilities,
			audio?.speechFrameSec,
			durationSec,
			DEFAULT_CUT_POINT_POLICY.sensitivity,
		).some((span) => span.startSec < endSec && span.endSec > startSec)
	);
}

export const cutMidSentence: CheckRule = {
	id: "cut.mid-sentence",
	severity: "error",
	audio: true,
	describe:
		"The cut lands inside speech (a sentence spans it, or audio continues on the removed side within 10 dB of the kept words), the removed footage is not a transcript-bounded sound of at most 1 s with complete detector silence inside one take, and its disagreement is at least 0.5s for transcript evidence or over 0.25s for mic/speech evidence; kept air after a sentence is not a finding. One strongest finding per cut.",
	fix: "setTrim adjusts matching trim endpoints when the corrected range remains valid.",
	run(context) {
		const findings: Finding[] = [];
		const notes = new Set<string>();
		const trimFixes = cutTrimFixes(context.document);
		for (const cut of context.cuts) {
			if (
				removesOnlyWordlessSound(
					cut,
					context.words.get(cut.left.assetId) ?? [],
					context.audio.get(cut.left.assetId),
					context.assets.find((asset) => asset.id === cut.left.assetId)?.durationSec,
				)
			)
				continue;
			for (const edge of ["out", "in"] as const) {
				const fragment = edge === "out" ? cut.left : cut.right;
				if (context.audioAssets && !context.audioAssets.has(fragment.assetId)) continue;
				const clip = context.document.timeline.clips.find((item) => item.id === fragment.clip);
				const asset = context.assets.find((item) => item.id === fragment.assetId);
				const words = context.words.get(fragment.assetId) ?? [];
				if (!clip || !asset?.durationSec || !words.length) {
					notes.add(
						`cut.mid-sentence skipped: transcript or duration unavailable for ${fragment.assetId}.`,
					);
					continue;
				}
				const audio = context.audio.get(asset.id);
				if (!audio?.microphonePeaks)
					notes.add(
						`cut.mid-sentence uses ${audio?.speechProbabilities ? "speech" : "transcript"} fallback for ${asset.id}; microphone peaks unavailable.`,
					);
				const timeSec = edge === "out" ? fragment.source.endSec : fragment.source.startSec;
				const plan = planCutPoint({
					clip,
					durationSec: asset.durationSec,
					timeSec,
					edge,
					words,
					microphonePeaks: audio?.microphonePeaks,
					speechProbabilities: audio?.speechProbabilities,
					speechFrameSec: audio?.speechFrameSec,
				});
				if (!plan.chosen) continue;
				const disagreementSec = Math.abs(plan.chosen.cutSec - timeSec);
				if (
					plan.chosen.method === "transcript"
						? disagreementSec < 0.5 - 1e-9
						: disagreementSec <= 0.25 + 1e-9
				)
					continue;
				if (
					!cutInsideSentence(
						words,
						timeSec,
						edge,
						plan.chosen,
						DEFAULT_CUT_POINT_POLICY.sentenceGapSec,
					) ||
					!removedSideHasSpeech(
						audio?.microphonePeaks,
						asset.durationSec,
						edge,
						timeSec,
						plan.chosen.cutSec,
					)
				)
					continue;
				const fix = trimFixes.fixFor(clip.id, edge, timeSec, plan.chosen.cutSec);
				findings.push({
					...finding(
						cutMidSentence,
						{ startSec: cut.at, endSec: cut.at },
						clip.id,
						`${edge === "out" ? "Out" : "In"}-point ${timeSec.toFixed(3)}s should be ${plan.chosen.cutSec.toFixed(3)}s (${plan.chosen.method}): ${plan.chosen.before} | ${plan.chosen.after}`,
						fix,
					),
					cutEvidence: { method: plan.chosen.method, disagreementSec },
				});
			}
		}
		trimFixes.dropInvalid(findings);
		return { findings, notes: [...notes] };
	},
};

export function strongestCutFindings(findings: Finding[]): Finding[] {
	const cuts = new Map<number, Finding>();
	const strength = { "mic-level": 3, speech: 2, transcript: 1 };
	for (const item of findings) {
		if (item.rule !== cutMidSentence.id || !item.cutEvidence) continue;
		const previous = cuts.get(item.at);
		const evidence = previous?.cutEvidence;
		if (
			!evidence ||
			strength[item.cutEvidence.method] > strength[evidence.method] ||
			(strength[item.cutEvidence.method] === strength[evidence.method] &&
				item.cutEvidence.disagreementSec > evidence.disagreementSec)
		)
			cuts.set(item.at, item);
	}
	return findings.filter(
		(item) => !item.cutEvidence || item.rule !== cutMidSentence.id || cuts.get(item.at) === item,
	);
}

import type { AxcutClip, AxcutDocument, AxcutTrimRange } from "../schema";
import type { PauseSuggestion } from "./pause-analysis";

export interface ProposedCut {
	id: string;
	clipId: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
	kind: "pause" | "blip" | "agent" | "fix";
	origin: string;
	selected: boolean;
	replacesTrim?: AxcutTrimRange;
	proposalKey?: string;
}

export interface SelectablePauseSuggestion extends Omit<PauseSuggestion, "kind">, ProposedCut {}

export function cutInDocument(
	cut: ProposedCut,
	document: AxcutDocument,
): SelectablePauseSuggestion | null {
	const clip = document.timeline.clips.find(
		(item) => item.id === cut.clipId && item.assetId === cut.assetId,
	);
	if (
		!clip ||
		clip.sourceEndSec === undefined ||
		!Number.isFinite(cut.sourceStartSec) ||
		!Number.isFinite(cut.sourceEndSec)
	)
		return null;
	const sourceStartSec = Math.max(clip.sourceStartSec, cut.sourceStartSec);
	const sourceEndSec = Math.min(clip.sourceEndSec, cut.sourceEndSec);
	if (sourceEndSec - sourceStartSec < 0.04 - 1e-9) return null;
	return {
		...cut,
		sourceStartSec,
		sourceEndSec,
		silenceStartSec:
			"silenceStartSec" in cut && typeof cut.silenceStartSec === "number"
				? cut.silenceStartSec
				: sourceStartSec,
		silenceEndSec:
			"silenceEndSec" in cut && typeof cut.silenceEndSec === "number"
				? cut.silenceEndSec
				: sourceEndSec,
		timelineStartSec: sourceToRaw(clip, sourceStartSec),
		timelineEndSec: sourceToRaw(clip, sourceEndSec),
		savedSec: sourceEndSec - sourceStartSec,
	};
}

export function sourceToRaw(clip: AxcutClip, sourceSec: number): number {
	return clip.timelineStartSec + sourceSec - clip.sourceStartSec;
}

export function cutRangeKey(
	cut: Pick<ProposedCut, "clipId" | "sourceStartSec" | "sourceEndSec">,
): string {
	return JSON.stringify([
		cut.clipId,
		Math.round(cut.sourceStartSec * 1000),
		Math.round(cut.sourceEndSec * 1000),
	]);
}

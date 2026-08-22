import type { AxcutDocument, AxcutTrimRange } from "../schema";
import type { PauseSuggestion } from "../timeline/pause-analysis";
import { trimAppliesToClip } from "../timeline/trim-mapping";

function overlaps(
	left: Pick<AxcutTrimRange, "startSec" | "endSec">,
	right: Pick<AxcutTrimRange, "startSec" | "endSec">,
): boolean {
	return left.endSec > right.startSec && left.startSec < right.endSec;
}

/**
 * Materialize confirmed pause suggestions as ordinary clip-anchored trims.
 * Existing edits always win. Stale or duplicate suggestions become no-ops, so
 * applyDocumentPatch can safely retry this transform against the latest document.
 */
export function applyPauseSuggestions(
	document: AxcutDocument,
	suggestions: PauseSuggestion[],
): AxcutDocument {
	const accepted: AxcutTrimRange[] = [];
	for (const suggestion of suggestions) {
		const clip = document.timeline.clips.find(
			(candidate) => candidate.id === suggestion.clipId && candidate.assetId === suggestion.assetId,
		);
		if (!clip) continue;
		const sourceEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
		const startSec = Math.max(clip.sourceStartSec, suggestion.sourceStartSec);
		const endSec = Math.min(sourceEndSec, suggestion.sourceEndSec);
		if (endSec - startSec < 0.04) continue;
		const next = { startSec, endSec };
		const blocked = [...document.timeline.trimRanges, ...accepted].some(
			(trim) => trimAppliesToClip(trim, clip) && overlaps(trim, next),
		);
		if (blocked) continue;
		accepted.push({
			id: suggestion.id,
			assetId: clip.assetId,
			clipId: clip.id,
			startSec,
			endSec,
			reason: "Shortened pause",
			origin: "user",
		});
	}
	if (accepted.length === 0) return document;
	return {
		...document,
		timeline: {
			...document.timeline,
			trimRanges: [...document.timeline.trimRanges, ...accepted].sort(
				(left, right) => left.startSec - right.startSec,
			),
		},
	};
}

export function pauseSuggestionsAsTrims(suggestions: PauseSuggestion[]): AxcutTrimRange[] {
	return suggestions.map((suggestion) => ({
		id: `preview_${suggestion.id}`,
		assetId: suggestion.assetId,
		clipId: suggestion.clipId,
		startSec: suggestion.sourceStartSec,
		endSec: suggestion.sourceEndSec,
		reason: "Pause preview",
		origin: "system",
	}));
}

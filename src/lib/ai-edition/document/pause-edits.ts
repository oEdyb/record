import type { AxcutDocument, AxcutTrimRange } from "../schema";
import type { ProposedCut } from "../timeline/proposed-cuts";

type Cut = Pick<ProposedCut, "id" | "clipId" | "assetId" | "sourceStartSec" | "sourceEndSec"> &
	Partial<Pick<ProposedCut, "origin" | "replacesTrim">>;

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
export function applyPauseSuggestions(document: AxcutDocument, suggestions: Cut[]): AxcutDocument {
	const accepted: AxcutTrimRange[] = [];
	const replaced = new Set<string>();
	const usedIds = new Set(document.timeline.trimRanges.map((trim) => trim.id));
	for (const suggestion of suggestions) {
		if (suggestion.replacesTrim && replaced.has(suggestion.replacesTrim.id)) continue;
		const clip = document.timeline.clips.find(
			(candidate) => candidate.id === suggestion.clipId && candidate.assetId === suggestion.assetId,
		);
		if (!clip) continue;
		const sourceEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
		const startSec = Math.max(clip.sourceStartSec, suggestion.sourceStartSec);
		const endSec = Math.min(sourceEndSec, suggestion.sourceEndSec);
		if (endSec - startSec < 0.04 - 1e-9) continue;
		if (
			suggestion.replacesTrim &&
			!document.timeline.trimRanges.some(
				(trim) => JSON.stringify(trim) === JSON.stringify(suggestion.replacesTrim),
			)
		)
			continue;
		const next = { startSec, endSec };
		const blocked = [
			...document.timeline.trimRanges.filter(
				(trim) => trim.id !== suggestion.replacesTrim?.id && !replaced.has(trim.id),
			),
			...accepted,
		].some((trim) => trimAppliesToClip(trim, clip) && overlaps(trim, next));
		if (blocked) continue;
		if (suggestion.replacesTrim) replaced.add(suggestion.replacesTrim.id);
		let id = suggestion.replacesTrim?.id ?? suggestion.id;
		if (!suggestion.replacesTrim) {
			let suffix = 1;
			while (usedIds.has(id)) id = `${suggestion.id}:${suffix++}`;
		}
		usedIds.add(id);
		accepted.push({
			...suggestion.replacesTrim,
			id,
			assetId: clip.assetId,
			clipId: clip.id,
			startSec,
			endSec,
			reason: suggestion.origin ?? "Shortened pause",
			origin: "user",
		});
	}
	if (accepted.length === 0) return document;
	return {
		...document,
		timeline: {
			...document.timeline,
			trimRanges: [
				...document.timeline.trimRanges.filter((trim) => !replaced.has(trim.id)),
				...accepted,
			].sort((left, right) => left.startSec - right.startSec),
		},
	};
}

export function pauseSuggestionsAsTrims(suggestions: Cut[]): AxcutTrimRange[] {
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

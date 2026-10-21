import type { AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import { effectiveKeep, keepDurationSec, regionAppliesAt } from "./keep";
import { cleanCutTrimRanges, sourceToTimeline } from "./timelineMap";
import type { CleanCutKeep, CleanCutRegion, CleanCutSnapshot, CleanCutStrength } from "./types";

/** A word cut as review lists it, with where it sits on the project timeline. */
export interface ReviewCut {
	region: CleanCutRegion;
	/** Project timeline (raw clock) start and end of the removed range. */
	rawStartSec: number;
	rawEndSec: number;
	removedSec: number;
	restored: boolean;
}

export interface CleanCutReviewModel {
	keep: CleanCutKeep[];
	trimRanges: AxcutTrimRange[];
	/** Word cuts active at this strength, unsure first, each group in timeline order. */
	cuts: ReviewCut[];
	unsureCount: number;
	/** Every region that shows on the project timeline, for the overview strip. */
	strip: ReviewCut[];
	keptSec: number;
}

/** The project timeline end of the clip that shows this time. */
function clipEndAt(clips: readonly AxcutClip[], rawSec: number): number | null {
	const clip = clips.find((c) => rawSec >= c.timelineStartSec && rawSec <= c.timelineEndSec);
	return clip ? clip.timelineEndSec : null;
}

/** Everything review derives from one snapshot, strength and set of restores. */
export function buildCleanCutReview(
	snapshot: CleanCutSnapshot,
	clips: readonly AxcutClip[],
	strength: CleanCutStrength,
	restored: ReadonlySet<string>,
): CleanCutReviewModel {
	const keep = effectiveKeep(snapshot.keep, snapshot.regions, strength, restored);
	const covered = new Set([
		...snapshot.keep.map((entry) => entry.assetId),
		...snapshot.regions.map((region) => region.assetId),
	]);
	const strip: ReviewCut[] = [];
	for (const region of snapshot.regions) {
		if (!regionAppliesAt(region, strength)) continue;
		const rawStartSec = sourceToTimeline(clips, region.assetId, region.removedStartSec);
		if (rawStartSec === null) continue;
		// A cut that runs past the end of its clip (the media can end a few frames before the
		// transcript) removes only what the clip shows, as the preview trim does.
		const rawEndSec =
			sourceToTimeline(clips, region.assetId, region.removedEndSec) ??
			clipEndAt(clips, rawStartSec);
		if (rawEndSec === null) continue;
		strip.push({
			region,
			rawStartSec,
			rawEndSec,
			removedSec: Math.min(region.removedEndSec - region.removedStartSec, rawEndSec - rawStartSec),
			restored: restored.has(region.id),
		});
	}
	strip.sort((a, b) => a.rawStartSec - b.rawStartSec);
	const words = strip.filter((cut) => cut.region.kind !== "pause");
	const unsure = words.filter((cut) => cut.region.risky);
	return {
		keep,
		trimRanges: cleanCutTrimRanges(clips, keep, covered),
		cuts: [...unsure, ...words.filter((cut) => !cut.region.risky)],
		unsureCount: unsure.length,
		strip,
		keptSec: keepDurationSec(keep),
	};
}

/**
 * The preview's segments as the play bar shows them: pieces of one clip that the clean
 * cut split apart read as one clip, so the bar keeps a gap only between real clips.
 */
export function joinSegmentsByClip(
	segments: readonly AxcutClip[],
	rawClipIdOf: (segment: AxcutClip) => string,
): AxcutClip[] {
	const joined: AxcutClip[] = [];
	let lastId: string | null = null;
	for (const segment of segments) {
		const id = rawClipIdOf(segment);
		const previous = joined[joined.length - 1];
		if (previous && id === lastId) {
			joined[joined.length - 1] = { ...previous, timelineEndSec: segment.timelineEndSec };
		} else {
			joined.push({ ...segment, id });
		}
		lastId = id;
	}
	return joined;
}

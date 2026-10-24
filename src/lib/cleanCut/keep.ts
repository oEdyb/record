import type { CleanCutKeep, CleanCutRegion, CleanCutStrength } from "./types";

/** Stretches closer than this are one stretch; regions abut their neighbours exactly. */
const JOIN_EPSILON_SEC = 0.001;

/** Pauses are silence, not mistakes, so every strength removes them. */
export function regionAppliesAt(region: CleanCutRegion, strength: CleanCutStrength): boolean {
	if (strength === "clean" || region.kind === "pause" || region.kind === "manual") return true;
	return new Set(region.sources).size >= 2;
}

/** The regions that are cut right now: active at this strength and not restored. */
export function activeRegions(
	regions: readonly CleanCutRegion[],
	strength: CleanCutStrength,
	restored: ReadonlySet<string>,
): CleanCutRegion[] {
	return regions.filter((region) => regionAppliesAt(region, strength) && !restored.has(region.id));
}

/** Puts the stretch right after the same recording's stretch that precedes it in source time. */
function insertStretch(keep: CleanCutKeep[], stretch: CleanCutKeep): CleanCutKeep[] {
	let before = -1;
	let first = -1;
	keep.forEach((entry, index) => {
		if (entry.assetId !== stretch.assetId) return;
		if (first === -1 || entry.startSec < keep[first].startSec) first = index;
		if (
			entry.startSec <= stretch.startSec &&
			(before === -1 || entry.startSec > keep[before].startSec)
		)
			before = index;
	});
	const at = before !== -1 ? before + 1 : first !== -1 ? first : keep.length;
	const next = [...keep];
	next.splice(at, 0, stretch);
	return next;
}

function mergeNeighbours(keep: CleanCutKeep[]): CleanCutKeep[] {
	const merged: CleanCutKeep[] = [];
	for (const entry of keep) {
		const previous = merged[merged.length - 1];
		if (
			previous &&
			previous.assetId === entry.assetId &&
			previous.endSec >= entry.startSec - JOIN_EPSILON_SEC &&
			entry.endSec >= previous.startSec - JOIN_EPSILON_SEC
		) {
			merged[merged.length - 1] = {
				assetId: entry.assetId,
				startSec: Math.min(previous.startSec, entry.startSec),
				endSec: Math.max(previous.endSec, entry.endSec),
			};
		} else {
			merged.push({ ...entry });
		}
	}
	return merged;
}

/**
 * The keep list with each restored region's removed range filled back in. Filled ranges
 * join the stretches they touch, so restoring every region between two stretches leaves one.
 */
export function applyRestores(
	keep: readonly CleanCutKeep[],
	regions: readonly CleanCutRegion[],
	restored: ReadonlySet<string> | readonly string[],
): CleanCutKeep[] {
	const ids = new Set(restored);
	let result = keep.map((entry) => ({ ...entry }));
	for (const region of regions) {
		if (!ids.has(region.id) || region.removedEndSec <= region.removedStartSec) continue;
		result = insertStretch(result, {
			assetId: region.assetId,
			startSec: region.removedStartSec,
			endSec: region.removedEndSec,
		});
	}
	return mergeNeighbours(result);
}

/** Regions that stay in the video: restored by the viewer, or not cut at this strength. */
export function keptRegionIds(
	regions: readonly CleanCutRegion[],
	strength: CleanCutStrength,
	restored: ReadonlySet<string>,
): Set<string> {
	const ids = new Set<string>();
	for (const region of regions) {
		if (restored.has(region.id) || !regionAppliesAt(region, strength)) ids.add(region.id);
	}
	return ids;
}

/** The keep list for this strength and these restores. */
export function effectiveKeep(
	keep: readonly CleanCutKeep[],
	regions: readonly CleanCutRegion[],
	strength: CleanCutStrength,
	restored: ReadonlySet<string>,
): CleanCutKeep[] {
	return applyRestores(keep, regions, keptRegionIds(regions, strength, restored));
}

export function keepDurationSec(keep: readonly CleanCutKeep[]): number {
	return keep.reduce((sum, entry) => sum + Math.max(0, entry.endSec - entry.startSec), 0);
}

import type { AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import { resolveClipSourceEndSec } from "@/lib/ai-edition/timeline/clipDuration";
import type { CleanCutKeep } from "./types";

const EDGE_SEC = 0.000_5;

function sourceEnd(clip: AxcutClip) {
	return resolveClipSourceEndSec(clip, undefined);
}

function byTimeline(clips: readonly AxcutClip[]) {
	return [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
}

/**
 * Where a moment of a recording sits on the project timeline (the document's raw clock),
 * or null when no clip shows it.
 */
export function sourceToTimeline(
	clips: readonly AxcutClip[],
	assetId: string,
	sourceSec: number,
): number | null {
	for (const clip of byTimeline(clips)) {
		if (clip.assetId !== assetId) continue;
		if (sourceSec < clip.sourceStartSec - EDGE_SEC || sourceSec > sourceEnd(clip) + EDGE_SEC)
			continue;
		const offset = Math.min(
			Math.max(sourceSec - clip.sourceStartSec, 0),
			clip.timelineEndSec - clip.timelineStartSec,
		);
		return clip.timelineStartSec + offset;
	}
	return null;
}

/** The recording and source second shown at a project timeline time, or null in a gap. */
export function timelineToSource(
	clips: readonly AxcutClip[],
	timelineSec: number,
): { assetId: string; sourceSec: number } | null {
	for (const clip of byTimeline(clips)) {
		if (
			timelineSec < clip.timelineStartSec - EDGE_SEC ||
			timelineSec > clip.timelineEndSec + EDGE_SEC
		)
			continue;
		const offset = Math.max(0, timelineSec - clip.timelineStartSec);
		return {
			assetId: clip.assetId,
			sourceSec: Math.min(clip.sourceStartSec + offset, sourceEnd(clip)),
		};
	}
	return null;
}

/**
 * The clean cut as preview-only trim ranges: whatever each covered clip shows outside the
 * keep list. Recordings the clean cut has not analysed are left alone.
 */
export function cleanCutTrimRanges(
	clips: readonly AxcutClip[],
	keep: readonly CleanCutKeep[],
	coveredAssetIds: ReadonlySet<string>,
): AxcutTrimRange[] {
	const trims: AxcutTrimRange[] = [];
	for (const clip of byTimeline(clips)) {
		if (!coveredAssetIds.has(clip.assetId)) continue;
		const start = clip.sourceStartSec;
		const end = sourceEnd(clip);
		const kept = keep
			.filter(
				(entry) => entry.assetId === clip.assetId && entry.endSec > start && entry.startSec < end,
			)
			.map((entry) => [Math.max(entry.startSec, start), Math.min(entry.endSec, end)] as const)
			.sort((a, b) => a[0] - b[0]);
		let cursor = start;
		const push = (from: number, to: number) => {
			if (to - from <= EDGE_SEC) return;
			trims.push({
				id: `clean-cut:${clip.id}:${trims.length}`,
				assetId: clip.assetId,
				clipId: clip.id,
				startSec: from,
				endSec: to,
				reason: "Clean cut",
				origin: "system",
			});
		};
		for (const [from, to] of kept) {
			push(cursor, from);
			cursor = Math.max(cursor, to);
		}
		push(cursor, end);
	}
	return trims;
}

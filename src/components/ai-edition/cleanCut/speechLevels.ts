import type { AxcutClip } from "@/lib/ai-edition/schema";
import { sourceToTimeline } from "@/lib/cleanCut/timelineMap";
import type { CleanCutWord } from "@/lib/cleanCut/types";

/** A spoken word on the playback clock, weighted so longer words read louder. */
export interface SpokenSpan {
	startSec: number;
	endSec: number;
	weight: number;
	/** The word plays again because its cut was restored. */
	restored: boolean;
}

export interface SpeechBin {
	level: number;
	restored: boolean;
}

/**
 * The words that play, on the playback clock. Words of an active cut never play, so they
 * leave no trace; the seam marks them instead.
 */
export function playbackSpans(
	words: readonly CleanCutWord[],
	clips: readonly AxcutClip[],
	cutIds: ReadonlySet<string>,
	restoredIds: ReadonlySet<string>,
	toPlaybackSec: (rawSec: number) => number,
): SpokenSpan[] {
	const spans: SpokenSpan[] = [];
	for (const word of words) {
		if (word.regionId !== null && cutIds.has(word.regionId)) continue;
		const rawStart = sourceToTimeline(clips, word.assetId, word.startSec);
		const rawEnd = sourceToTimeline(clips, word.assetId, word.endSec);
		if (rawStart === null || rawEnd === null) continue;
		const startSec = toPlaybackSec(rawStart);
		const endSec = toPlaybackSec(rawEnd);
		if (endSec <= startSec) continue;
		const letters = word.text.replace(/[^\p{L}\p{N}]/gu, "").length;
		spans.push({
			startSec,
			endSec,
			weight: 0.55 + 0.45 * Math.min(1, letters / 8),
			restored: word.regionId !== null && restoredIds.has(word.regionId),
		});
	}
	return spans.sort((a, b) => a.startSec - b.startSec);
}

/**
 * How much speech each of `count` equal bins of `totalSec` holds, 0 to 1: the transcript
 * drawn as a level meter, so silence reads flat and talk reads tall.
 */
export function speechBins(spans: readonly SpokenSpan[], totalSec: number, count: number) {
	const levels = new Array<number>(Math.max(0, count)).fill(0);
	const restored = new Array<boolean>(Math.max(0, count)).fill(false);
	const binSec = totalSec / Math.max(1, count);
	if (binSec <= 0) return [];
	for (const span of spans) {
		const first = Math.max(0, Math.floor(span.startSec / binSec));
		const last = Math.min(count - 1, Math.floor(span.endSec / binSec));
		for (let bin = first; bin <= last; bin += 1) {
			const binStart = bin * binSec;
			const overlap = Math.min(span.endSec, binStart + binSec) - Math.max(span.startSec, binStart);
			if (overlap <= 0) continue;
			levels[bin] += (overlap / binSec) * span.weight;
			if (span.restored) restored[bin] = true;
		}
	}
	return levels.map<SpeechBin>((level, index) => {
		const previous = levels[index - 1] ?? level;
		const next = levels[index + 1] ?? level;
		return {
			level: Math.min(1, (previous + 2 * level + next) / 4) ** 0.7,
			restored: restored[index],
		};
	});
}

import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import type { CleanCutWord } from "@/lib/cleanCut/types";

/** Cuts closer than this in what plays close into one seam. */
const MOMENT_SEC = 1;

/** Word cuts that land on the same moment of what plays: one seam in the clean video. */
export interface CutMoment {
	key: string;
	/** Where the seam sits on the playback clock. */
	atSec: number;
	cuts: ReviewCut[];
	/** Time the moment still removes; restored cuts add nothing. */
	removedSec: number;
	unsure: boolean;
}

function wordCutsInOrder(cuts: readonly ReviewCut[]) {
	return cuts
		.filter((cut) => cut.region.kind !== "pause")
		.sort((a, b) => a.rawStartSec - b.rawStartSec);
}

function startMoment(cut: ReviewCut, atSec: number): CutMoment {
	return {
		key: cut.region.id,
		atSec,
		cuts: [cut],
		removedSec: cut.restored ? 0 : cut.removedSec,
		unsure: cut.region.risky,
	};
}

function addTo(moment: CutMoment, cut: ReviewCut) {
	moment.cuts.push(cut);
	moment.removedSec += cut.restored ? 0 : cut.removedSec;
	moment.unsure ||= cut.region.risky;
}

/**
 * Groups word cuts into the moments they close into: neighbours with less than a second
 * of kept speech between them. What lies between two cuts is never a cut, so restoring
 * one keeps its group whole and the list does not shift under the viewer.
 */
export function groupMoments(
	cuts: readonly ReviewCut[],
	toPlaybackSec: (rawSec: number) => number,
): CutMoment[] {
	const moments: CutMoment[] = [];
	let previous: ReviewCut | null = null;
	for (const cut of wordCutsInOrder(cuts)) {
		const last = moments[moments.length - 1];
		const between = previous
			? toPlaybackSec(cut.rawStartSec) - toPlaybackSec(previous.rawEndSec)
			: Number.POSITIVE_INFINITY;
		if (last && between < MOMENT_SEC) addTo(last, cut);
		else moments.push(startMoment(cut, toPlaybackSec(cut.rawStartSec)));
		previous = cut;
	}
	return moments;
}

/** Each cut's moment, by region id. */
export function momentsById(moments: readonly CutMoment[]): Map<string, CutMoment> {
	const byId = new Map<string, CutMoment>();
	for (const moment of moments) for (const cut of moment.cuts) byId.set(cut.region.id, moment);
	return byId;
}

/** The kind every cut in a moment shares, or null when they differ. */
export function sharedKind(moment: CutMoment): ReviewCut["region"]["kind"] | null {
	const kind = moment.cuts[0]?.region.kind ?? null;
	return moment.cuts.every((cut) => cut.region.kind === kind) ? kind : null;
}

/** Pauses: silence the clean cut lifts out, kept apart from the word cuts. */
export function pauseCuts(strip: readonly ReviewCut[]): ReviewCut[] {
	return strip.filter((cut) => cut.region.kind === "pause");
}

/** Time a set of cuts still removes; restored cuts add nothing. */
export function removedSecOf(cuts: readonly ReviewCut[]): number {
	return cuts.reduce((sum, cut) => sum + (cut.restored ? 0 : cut.removedSec), 0);
}

/** Seconds of speech inside each cut, by region id; the rest of a cut is silence. */
export function spokenSecByRegion(words: readonly CleanCutWord[]): Map<string, number> {
	const spoken = new Map<string, number>();
	for (const word of words) {
		if (!word.regionId) continue;
		spoken.set(word.regionId, (spoken.get(word.regionId) ?? 0) + (word.endSec - word.startSec));
	}
	return spoken;
}

/** Silence a cut removes along with its words, worth a mention from one second up. */
export function silenceSecOf(cut: ReviewCut, spoken: ReadonlyMap<string, number>): number {
	const silence = cut.removedSec - (spoken.get(cut.region.id) ?? 0);
	return silence >= 1 ? silence : 0;
}

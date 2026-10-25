import type { CutMoment } from "./moments";

/** The narrowest click target a mark offers. */
export const MIN_TARGET_PX = 12;
/** Marks closer than this nudge apart so each stays its own dot. */
export const MIN_MARK_GAP_PX = 7;

export interface CutMark {
	moment: CutMoment;
	/** Where the moment closes on the bar: the seam the mark sits on, in px. */
	x: number;
	/** Every cut in it is restored: it plays, and only a ring is left. */
	restored: boolean;
}

/**
 * One mark per moment on the playback clock, at the seam where playback jumps past it.
 * The removed time is not on this clock, so a mark claims no width; where two seams sit
 * closer than MIN_MARK_GAP_PX they nudge apart, staying inside the bar.
 */
export function layoutCutMarks(
	moments: readonly CutMoment[],
	seamSec: (moment: CutMoment) => number,
	totalSec: number,
	width: number,
): CutMark[] {
	if (totalSec <= 0 || width <= 0) return [];
	const marks = moments
		.map((moment) => ({
			moment,
			x: Math.min(width, Math.max(0, (seamSec(moment) / totalSec) * width)),
			restored: moment.removedSec <= 0,
		}))
		.sort((a, b) => a.x - b.x);
	for (let i = 1; i < marks.length; i += 1)
		marks[i].x = Math.max(marks[i].x, marks[i - 1].x + MIN_MARK_GAP_PX);
	const overflow = marks.length > 0 ? marks[marks.length - 1].x - width : 0;
	if (overflow > 0)
		for (let i = marks.length - 1; i >= 0; i -= 1) {
			const limit = i === marks.length - 1 ? width : marks[i + 1].x - MIN_MARK_GAP_PX;
			marks[i].x = Math.max(0, Math.min(marks[i].x, limit));
		}
	return marks;
}

/** A mark's click target, MIN_TARGET_PX wide and centred on it. */
export function markTarget(mark: CutMark): { left: number; width: number } {
	return { left: mark.x - MIN_TARGET_PX / 2, width: MIN_TARGET_PX };
}

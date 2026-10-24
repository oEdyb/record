import type { CutMoment } from "./moments";

/** The narrowest block a moment draws, so a short cut still shows. */
export const MIN_BLOCK_PX = 3;
/** The narrowest click target a block offers. */
export const MIN_TARGET_PX = 12;

export interface CutBlock {
	moment: CutMoment;
	/** Left and right edge of the drawn block, in px along the bar. */
	left: number;
	right: number;
	/** Where the moment closes on the bar: the seam the block sits on. */
	seam: number;
	/** Every cut in it is restored: it plays, and only an outline is left. */
	restored: boolean;
}

/**
 * One block per moment on the playback clock, centred on its seam and as wide as the time
 * it removes at the bar's own scale. Blocks never overlap: where two would, they meet
 * halfway with a pixel between them, and each keeps its minimum width.
 */
export function layoutCutBlocks(
	moments: readonly CutMoment[],
	seamSec: (moment: CutMoment) => number,
	totalSec: number,
	width: number,
): CutBlock[] {
	if (totalSec <= 0 || width <= 0) return [];
	const pxPerSec = width / totalSec;
	const blocks = moments
		.map((moment) => {
			const seam = Math.min(width, Math.max(0, seamSec(moment) * pxPerSec));
			const half = Math.max(MIN_BLOCK_PX, moment.removedSec * pxPerSec) / 2;
			return {
				moment,
				seam,
				left: Math.max(0, seam - half),
				right: Math.min(width, seam + half),
				restored: moment.removedSec <= 0,
			};
		})
		.sort((a, b) => a.seam - b.seam);
	for (let i = 1; i < blocks.length; i += 1) {
		const previous = blocks[i - 1];
		const block = blocks[i];
		if (block.left >= previous.right + 1) continue;
		const meet = Math.min(
			Math.max((previous.right + block.left) / 2, previous.left + MIN_BLOCK_PX + 0.5),
			block.right - MIN_BLOCK_PX - 0.5,
		);
		previous.right = Math.max(previous.left + MIN_BLOCK_PX, meet - 0.5);
		block.left = previous.right + 1;
		block.right = Math.max(block.right, block.left + MIN_BLOCK_PX);
	}
	for (const block of blocks) {
		if (block.right > width) {
			block.right = width;
			block.left = Math.min(block.left, width - MIN_BLOCK_PX);
		}
	}
	return blocks;
}

/** A block's click target: at least MIN_TARGET_PX wide, centred on the block. */
export function blockTarget(block: CutBlock): { left: number; width: number } {
	const width = Math.max(MIN_TARGET_PX, block.right - block.left);
	return { left: (block.left + block.right) / 2 - width / 2, width };
}

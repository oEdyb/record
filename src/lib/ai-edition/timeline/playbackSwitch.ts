import type { AxcutClip } from "../schema";
import { findRawClipForSegment } from "./virtual-preview";

/**
 * True while the preview has been pointed at a clip on another asset but the
 * `<video>` on screen still belongs to the old one. The frame loop must not judge
 * the old element with the new clip as its hint: it would read "not in a kept part"
 * and jump the old clip forward, cancelling the seek the user just made.
 */
export function assetSwitchInFlight(
	clips: AxcutClip[],
	activeClipId: string | null,
	activeAssetId: string | undefined,
): boolean {
	if (!activeClipId || !activeAssetId) return false;
	const hinted = clips.find((clip) => clip.id === activeClipId);
	return hinted !== undefined && hinted.assetId !== activeAssetId;
}

/** Playback uses exact cut edges; the scrub mapper's 50 ms tolerance can select a future fragment. */
export function playingFragment(
	fragments: AxcutClip[],
	clips: AxcutClip[],
	sourceTimeSec: number,
	assetId: string | undefined,
	clipId: string | null,
): AxcutClip | undefined {
	return fragments.find(
		(fragment) =>
			fragment.assetId === assetId &&
			(!clipId || findRawClipForSegment(fragment, clips)?.id === clipId) &&
			sourceTimeSec >= fragment.sourceStartSec - 0.000001 &&
			sourceTimeSec < (fragment.sourceEndSec ?? fragment.sourceStartSec),
	);
}

import { resolveClipInsertionBoundary } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip } from "@/lib/ai-edition/schema";

export type RecordingTarget = "new" | "add";

/** Record makes a new recording in review; Add clip, and the full editor, record into the open one. */
export function recordsIntoOpenProject(target: RecordingTarget, recordingOnly: boolean): boolean {
	return target === "add" || !recordingOnly;
}

/** The end of the recording until the viewer moves the playhead, then the nearest clip boundary. */
export function reviewInsertionTime(
	clips: AxcutClip[],
	playheadSec: number,
	followsPlayhead: boolean,
): number {
	if (followsPlayhead) return resolveClipInsertionBoundary(clips, playheadSec);
	return clips.reduce((end, clip) => Math.max(end, clip.timelineEndSec), 0);
}

import { powerSaveBlocker } from "electron";

let blockerId: number | null = null;

/** Keeps a Linux take awake, pauses included; repeated state events share one blocker. */
export function setDisplaySleepBlocked(recording: boolean) {
	if (process.platform !== "linux") return;
	if (recording && blockerId === null) {
		blockerId = powerSaveBlocker.start("prevent-display-sleep");
	} else if (!recording && blockerId !== null) {
		powerSaveBlocker.stop(blockerId);
		blockerId = null;
	}
}

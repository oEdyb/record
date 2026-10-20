import type { MenuItemConstructorOptions } from "electron";
import { mainT } from "../i18n";

export type RecordingReviewMenuChannel =
	| "menu-new-project"
	| "menu-load-project"
	| "menu-save-project";

/** A menu action must never replace the HUD while its writer is active. */
export function canDispatchRecordingReviewMenu(
	channel: string,
	state: { recordingOnly: boolean; isRecording: boolean; targetIsReview: boolean },
): boolean {
	if (!state.recordingOnly) return true;
	if (state.isRecording) return false;
	// Record already has its setup surface. Save needs a completed recording.
	return state.targetIsReview || channel === "menu-load-project";
}

/** Keep native accelerators and renderer actions on the same recorder workflow. */
export function recordingReviewFileMenu(
	send: (channel: RecordingReviewMenuChannel) => void,
): MenuItemConstructorOptions[] {
	return [
		{
			id: "recording-new",
			label: mainT("common", "menu.newRecording"),
			accelerator: "CmdOrCtrl+N",
			click: () => send("menu-new-project"),
		},
		{
			id: "recording-library",
			label: mainT("common", "menu.recordings"),
			accelerator: "CmdOrCtrl+O",
			click: () => send("menu-load-project"),
		},
		{
			id: "recording-save",
			label: mainT("common", "menu.saveVideo"),
			accelerator: "CmdOrCtrl+S",
			click: () => send("menu-save-project"),
		},
	];
}

import { describe, expect, it, vi } from "vitest";
import { canDispatchRecordingReviewMenu, recordingReviewFileMenu } from "./recordingReviewFileMenu";

describe("native recorder File menu", () => {
	it("keeps every File action from closing an active recording HUD", () => {
		for (const channel of ["menu-new-project", "menu-load-project", "menu-save-project"])
			expect(
				canDispatchRecordingReviewMenu(channel, {
					recordingOnly: true,
					isRecording: true,
					targetIsReview: false,
				}),
			).toBe(false);
	});
	it("keeps Record and Save on the idle HUD while allowing its library", () => {
		const hud = { recordingOnly: true, isRecording: false, targetIsReview: false };
		expect(canDispatchRecordingReviewMenu("menu-new-project", hud)).toBe(false);
		expect(canDispatchRecordingReviewMenu("menu-save-project", hud)).toBe(false);
		expect(canDispatchRecordingReviewMenu("menu-load-project", hud)).toBe(true);
		expect(
			canDispatchRecordingReviewMenu("menu-save-project", { ...hud, targetIsReview: true }),
		).toBe(true);
	});
	it("preserves the existing menu dispatch when recording focus is disabled", () => {
		expect(
			canDispatchRecordingReviewMenu("menu-save-project-as", {
				recordingOnly: false,
				isRecording: true,
				targetIsReview: false,
			}),
		).toBe(true);
	});
	it("dispatches the recorder channels through the native Mac/Windows accelerators", () => {
		const send = vi.fn(),
			items = recordingReviewFileMenu(send);
		expect(items.map(({ label, accelerator }) => ({ label, accelerator }))).toEqual([
			{ label: "Record", accelerator: "CmdOrCtrl+N" },
			{ label: "Recordings…", accelerator: "CmdOrCtrl+O" },
			{ label: "Save video…", accelerator: "CmdOrCtrl+S" },
		]);
		for (const item of items)
			item.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
		expect(send.mock.calls.map(([channel]) => channel)).toEqual([
			"menu-new-project",
			"menu-load-project",
			"menu-save-project",
		]);
	});
});

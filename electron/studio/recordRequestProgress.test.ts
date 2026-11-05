import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { RendererIpcMain } from "../ipc/trustedRendererIpc";
import { registerStudioIpc } from "./ipc";
import { parseRecordRequestProgress } from "./recordRequestProgress";
import type { StudioController } from "./studioController";

describe("Record progress boundary", () => {
	it("drops arbitrary text stages and keys before they can enter the trace", () => {
		expect(
			parseRecordRequestProgress({ token: 1, stage: "private-device-name", flags: {} }),
		).toBeNull();
		expect(parseRecordRequestProgress({ token: 0, stage: "receipt" })).toBeNull();
		expect(
			parseRecordRequestProgress({
				token: 1,
				stage: "receipt",
				flags: {
					saving: false,
					"private-device-name": true,
					recordingId: "filename.mp4",
					starting: Infinity,
				},
			}),
		).toEqual({ token: 1, stage: "receipt", flags: { saving: false } });
	});

	it("invalidates a subscribed owner on navigation, crash and destruction", () => {
		const events = new EventEmitter();
		const sender = new EventEmitter();
		const unavailable = vi.fn();
		const studio = {
			recordReady: vi.fn(),
			isRecordingOwner: (value: object) => value === sender,
			recordUnavailable: unavailable,
		} as unknown as StudioController;
		const ipc = { on: events.on.bind(events), handle: vi.fn() } as unknown as RendererIpcMain;
		registerStudioIpc(ipc, studio);
		events.emit("studio-record-ready", { sender }, true);
		events.emit("studio-record-ready", { sender }, true);
		sender.emit("did-start-navigation");
		sender.emit("render-process-gone");
		sender.emit("destroyed");
		expect(unavailable).toHaveBeenCalledTimes(3);
		expect(unavailable).toHaveBeenCalledWith(sender);
	});
});

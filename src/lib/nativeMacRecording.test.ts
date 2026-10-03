import { describe, expect, it } from "vitest";
import {
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
	parseNativeMacRecordingClip,
} from "./nativeMacRecording";

describe("nativeMacRecording source parsing", () => {
	it("preserves optional original paths and finite offsets in native clip acknowledgments", () => {
		const clip = {
			index: 0,
			screenVideoPath: "/screen.mp4",
			durationMs: 1000,
			webcamVideoPath: "/camera.mov",
			webcamOffsetMs: 0,
			microphoneAudioPath: "/microphone.m4a",
			microphoneAudioOffsetMs: 23.5,
			systemAudioPath: "/system.m4a",
			systemAudioOffsetMs: 4,
		};
		expect(parseNativeMacRecordingClip(clip)).toEqual(clip);
		expect(
			parseNativeMacRecordingClip({
				...clip,
				microphoneAudioPath: "  ",
				microphoneAudioOffsetMs: Number.NaN,
			}),
		).not.toHaveProperty("microphoneAudioPath");
	});
	it("parses Electron window source ids into ScreenCaptureKit window ids", () => {
		expect(parseMacWindowIdFromSourceId("window:12345:0")).toBe(12345);
		expect(parseMacWindowIdFromSourceId("window:987")).toBe(987);
	});

	it("rejects non-window source ids for window parsing", () => {
		expect(parseMacWindowIdFromSourceId("screen:1:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId("window:not-a-number:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId(null)).toBeNull();
	});

	it("parses Electron display source ids into ScreenCaptureKit display ids", () => {
		expect(parseMacDisplayIdFromSourceId("screen:1:0")).toBe(1);
		expect(parseMacDisplayIdFromSourceId("screen:69733248")).toBe(69733248);
	});

	it("rejects non-display source ids for display parsing", () => {
		expect(parseMacDisplayIdFromSourceId("window:123:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId("screen:not-a-number:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId(undefined)).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import {
	buildNativeMacRecordingRequest,
	computeCaptureBitrate,
	nativeMacWebcamFileName,
	selectRecorderMimeType,
} from "./capturePolicy";

describe("capture policy", () => {
	it("chooses the first supported live recorder format", () => {
		expect(selectRecorderMimeType((type) => type.includes("vp8"))).toBe("video/webm;codecs=vp8");
		expect(selectRecorderMimeType(() => false)).toBe("video/webm");
	});

	it("scales bitrate by resolution and frame rate", () => {
		expect(computeCaptureBitrate(1920, 1080, 30)).toBe(18_000_000);
		expect(computeCaptureBitrate(2560, 1440, 60)).toBe(47_600_000);
		expect(computeCaptureBitrate(3840, 2160, 60)).toBe(76_500_000);
	});

	it("builds a complete next-clip request from one settings snapshot", () => {
		const request = buildNativeMacRecordingRequest({
			source: { id: "window:42:0", display_id: "7" },
			recordingId: 123,
			settings: {
				systemAudioEnabled: true,
				microphone: {
					enabled: true,
					deviceId: "mic-id",
					deviceName: "Studio Mic",
					gain: 1.5,
				},
				webcam: {
					enabled: true,
					deviceId: "cam-id",
					deviceName: "Studio Cam",
					format: { width: 2560, height: 1440, fps: 30 },
				},
				cursorCaptureMode: "system",
			},
		});

		expect(request).toMatchObject({
			recordingId: 123,
			source: { type: "window", displayId: 7, windowId: 42 },
			video: { bitrate: 68_000_000, hideSystemCursor: false },
			audio: { system: { enabled: true }, microphone: { deviceId: "mic-id" } },
			webcam: { width: 2560, height: 1440, fps: 30 },
			cursor: { mode: "system" },
		});
	});

	it("uses stable per-clip webcam names", () => {
		expect(nativeMacWebcamFileName(123, 0)).toBe("recording-123-clip-0001-webcam.webm");
		expect(nativeMacWebcamFileName(123, 11)).toBe("recording-123-clip-0012-webcam.webm");
	});
});

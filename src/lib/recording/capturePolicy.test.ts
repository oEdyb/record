import { describe, expect, it } from "vitest";
import {
	buildNativeLinuxClipRecordingRequest,
	buildNativeMacRecordingRequest,
	computeCaptureBitrate,
	isClipOwnedWebcamPath,
	nativeMacWebcamFileName,
	selectNativeWebcamFormat,
	selectRecorderMimeType,
} from "./capturePolicy";
import {
	DEFAULT_RECORDING_QUALITY,
	normalizeRecordingQuality,
	recordingQualityBitrate,
} from "./recordingQuality";

describe("capture policy", () => {
	it("keeps the historical UI bitrate in Standard and doubles it in High", () => {
		expect(DEFAULT_RECORDING_QUALITY).toBe("high");
		expect(normalizeRecordingQuality(undefined)).toBe("high");
		expect(recordingQualityBitrate("standard")).toBe(68_000_000);
		expect(recordingQualityBitrate("high")).toBe(136_000_000);
	});
	it("chooses the first supported live recorder format", () => {
		expect(selectRecorderMimeType((type) => type.includes("vp8"))).toBe("video/webm;codecs=vp8");
		expect(selectRecorderMimeType(() => false)).toBe("video/webm");
	});

	it("selects fragmented H.264 MP4 only for a supporting Linux camera recorder", () => {
		expect(selectNativeWebcamFormat("linux", () => true)).toEqual({
			container: "mp4",
			options: { mimeType: "video/mp4;codecs=avc1", videoKeyFrameIntervalDuration: 500 },
		});
		for (const platform of ["darwin", "win32"]) {
			expect(selectNativeWebcamFormat(platform, () => true)).toEqual({
				container: "webm",
				options: { mimeType: "video/webm;codecs=h264" },
			});
		}
		expect(selectNativeWebcamFormat("linux", (mime) => mime.includes("vp8"))).toEqual({
			container: "webm",
			options: { mimeType: "video/webm;codecs=vp8" },
		});
		expect(nativeMacWebcamFileName(123, 0, "mp4")).toBe("recording-123-clip-0001-webcam.mp4");
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
					formatAuto: false,
				},
				cursorCaptureMode: "system",
			},
		});

		expect(request).toMatchObject({
			recordingId: 123,
			source: { type: "window", displayId: 7, windowId: 42 },
			video: { quality: "high", bitrate: 136_000_000, hideSystemCursor: false },
			audio: { system: { enabled: true }, microphone: { deviceId: "mic-id" } },
			webcam: { width: 2560, height: 1440, fps: 30, exactFormat: true },
			cursor: { mode: "system" },
		});
	});

	it.each<{ quality: "standard" | "high"; bitrate: number }>([
		{ quality: "standard", bitrate: 68_000_000 },
		{ quality: "high", bitrate: 136_000_000 },
	])("Linux $quality requests the shared bitrate, 60 fps, portal source and renderer camera", ({
		quality,
		bitrate,
	}) => {
		const request = buildNativeLinuxClipRecordingRequest({
			recordingId: 123,
			settings: {
				recordingQuality: quality,
				systemAudioEnabled: true,
				microphone: { enabled: true, deviceName: "Studio Mic", gain: 1.5 },
				webcam: { enabled: true, format: { width: 1920, height: 1080, fps: 60 }, formatAuto: true },
				cursorCaptureMode: "system",
			},
		});
		expect(request).toMatchObject({
			platform: "linux",
			source: { sourceId: "portal:selected" },
			video: { quality, bitrate, fps: 60, hideSystemCursor: false },
			webcam: { enabled: false },
			audio: { microphone: { deviceName: "Studio Mic" } },
			cursor: { mode: "system" },
			outputs: { screenPath: "" },
		});
		expect(request.source.displayId).toBeUndefined();
		expect(request.source.windowId).toBeUndefined();
	});

	it("uses stable per-clip webcam names", () => {
		expect(nativeMacWebcamFileName(123, 0)).toBe("recording-123-clip-0001-webcam.webm");
		expect(nativeMacWebcamFileName(123, 11)).toBe("recording-123-clip-0012-webcam.webm");
	});

	it("recognizes a camera file recorded for exactly one screen clip", () => {
		expect(
			isClipOwnedWebcamPath(
				"/r/recording-1789653794581-clip-0003.mp4",
				"/r/recording-1789653794581-clip-0003-webcam.webm",
			),
		).toBe(true);
		// One continuous camera file for the whole session is named after the recording.
		expect(
			isClipOwnedWebcamPath(
				"/r/recording-1789653794581-clip-0003.mp4",
				"/r/recording-1789653794581-webcam.webm",
			),
		).toBe(false);
		// Another clip's camera file never counts as this clip's own.
		expect(
			isClipOwnedWebcamPath(
				"/r/recording-1789653794581-clip-0003.mp4",
				"/r/recording-1789653794581-clip-0002-webcam.webm",
			),
		).toBe(false);
		expect(
			isClipOwnedWebcamPath(
				"C:\\r\\recording-1-clip-0001.mp4",
				"C:\\r\\recording-1-clip-0001-webcam.webm",
			),
		).toBe(true);
	});
});

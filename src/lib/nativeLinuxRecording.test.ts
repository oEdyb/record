import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxClipRecordingRequest, portalOwnsSourceSelection } from "./nativeLinuxRecording";

function probe(platform: string, available: boolean | Error) {
	return {
		getPlatform: () => platform,
		isNativeLinuxCaptureAvailable: vi.fn(async () => {
			if (available instanceof Error) {
				throw available;
			}
			return { success: true, available };
		}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("portalOwnsSourceSelection", () => {
	/**
	 * The regression. The recorder asks this question in two places — before the
	 * countdown and before capture — and the countdown's gate was missed, so the
	 * HUD offered no way to pick a source and then refused to record without one.
	 */
	it("is true on Linux when the native helper is available", async () => {
		await expect(portalOwnsSourceSelection(probe("linux", true))).resolves.toBe(true);
	});

	it("is false when the Linux native helper is unavailable", async () => {
		await expect(portalOwnsSourceSelection(probe("linux", false))).resolves.toBe(false);
	});

	it.each([
		"darwin",
		"win32",
	])("is false on %s, which targets a window directly", async (platform) => {
		const api = probe(platform, true);

		await expect(portalOwnsSourceSelection(api)).resolves.toBe(false);
		// Not merely false — the question is never asked off Linux.
		expect(api.isNativeLinuxCaptureAvailable).not.toHaveBeenCalled();
	});

	it("keeps the gate when the availability check fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {
			// Expected: the failure is reported, not swallowed silently.
		});

		await expect(portalOwnsSourceSelection(probe("linux", new Error("IPC is gone")))).resolves.toBe(
			false,
		);
	});

	it("keeps the gate when the helper reports failure rather than availability", async () => {
		await expect(
			portalOwnsSourceSelection({
				getPlatform: () => "linux",
				isNativeLinuxCaptureAvailable: async () => ({ success: false, available: true }),
			}),
		).resolves.toBe(false);
	});
});

describe("legacy Linux clip request adapter", () => {
	it("opens the system default instead of resolving its display label as a device", () => {
		const base = linuxClipRecordingRequest({
			video: { fps: 60 },
			audio: { system: { enabled: true }, microphone: { enabled: true, gain: 1 } },
			cursor: { mode: "system" },
		});
		const result = linuxClipRecordingRequest({
			...base,
			audio: {
				...base.audio,
				microphone: { enabled: true, gain: 1.4, deviceId: "default", deviceName: "Default" },
			},
		});
		expect(result.audio.microphone).toEqual({ enabled: true, gain: 1.4, deviceId: "default" });
		const explicit = {
			enabled: true,
			gain: 1,
			deviceId: "specific",
			deviceName: "Easy Effects Source",
		};
		expect(
			linuxClipRecordingRequest({ ...base, audio: { ...base.audio, microphone: explicit } }).audio
				.microphone,
		).toEqual(explicit);
	});

	it("passes a request without an audio block through instead of throwing", () => {
		const incomplete = {
			schemaVersion: 1,
			video: { fps: 60 },
			webcam: { enabled: false },
		} as unknown as Parameters<typeof linuxClipRecordingRequest>[0];
		expect(() => linuxClipRecordingRequest(incomplete)).not.toThrow();
		expect(linuxClipRecordingRequest(incomplete)).toMatchObject({
			platform: "linux",
			video: { fps: 60 },
			webcam: { enabled: false },
		});
	});

	it("keeps native preparation stable when the renderer camera finishes opening", () => {
		const base = linuxClipRecordingRequest({
			recordingId: 7,
			video: { fps: 60 },
			audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
			cursor: { mode: "system" },
		});
		const before = linuxClipRecordingRequest({
			...base,
			webcam: { enabled: true, width: 1920, height: 1080, fps: 30 },
		});
		const after = linuxClipRecordingRequest({
			...base,
			webcam: { enabled: true, width: 1920, height: 1080, fps: 60, deviceId: "opened-camera" },
		});
		expect(after).toEqual(before);
		expect(after.webcam.enabled).toBe(false);
	});

	it("keeps explicit capture settings while supplying the canonical output/source/camera contract", () => {
		const request = linuxClipRecordingRequest({
			recordingId: 7,
			video: { fps: 60, bitrate: 68_000_000 },
			audio: { system: { enabled: true }, microphone: { enabled: false, gain: 1 } },
			cursor: { mode: "system" },
		});
		expect(request).toMatchObject({
			platform: "linux",
			recordingId: 7,
			source: { sourceId: "portal:selected" },
			video: { fps: 60, bitrate: 68_000_000, hideSystemCursor: false },
			webcam: { enabled: false },
			outputs: { screenPath: "" },
		});
	});
});

import { describe, expect, it, vi } from "vitest";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import { prepareNativeMacCapturePermissions } from "./nativeMacCapturePermissions";

const request: NativeMacRecordingRequest = {
	schemaVersion: 1,
	source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
	video: { fps: 60, width: 1920, height: 1080, hideSystemCursor: false },
	audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
	webcam: { enabled: false, width: 1920, height: 1080, fps: 30 },
	cursor: { mode: "system" },
	outputs: { screenPath: "/tmp/capture.mp4" },
};

describe("prepareNativeMacCapturePermissions", () => {
	it("skips source enumeration when screen permission is already granted", async () => {
		const deps = {
			getStatus: vi.fn(() => "granted"),
			requestScreenAccess: vi.fn(async () => []),
			requestMicrophoneAccess: vi.fn(async () => true),
		};
		await prepareNativeMacCapturePermissions(request, deps);
		expect(deps.requestScreenAccess).not.toHaveBeenCalled();
		expect(deps.requestMicrophoneAccess).not.toHaveBeenCalled();
	});

	it.each([
		"not-determined",
		"denied",
		"restricted",
		"unknown",
	])("retains permission negotiation when screen permission is %s", async (status) => {
		const deps = {
			getStatus: vi.fn(() => status),
			requestScreenAccess: vi.fn(async () => []),
			requestMicrophoneAccess: vi.fn(async () => true),
		};
		await prepareNativeMacCapturePermissions(request, deps);
		expect(deps.requestScreenAccess).toHaveBeenCalledOnce();
	});

	it("leaves final screen permission validation to the native helper", async () => {
		await expect(
			prepareNativeMacCapturePermissions(request, {
				getStatus: () => "unknown",
				requestScreenAccess: async () => {
					throw new Error("Permission denied");
				},
				requestMicrophoneAccess: async () => true,
			}),
		).resolves.toBeUndefined();
	});

	it("retains screen permission negotiation if the status API is unavailable", async () => {
		const requestScreenAccess = vi.fn(async () => []);
		await prepareNativeMacCapturePermissions(request, {
			getStatus: () => {
				throw new Error("Status unavailable");
			},
			requestScreenAccess,
			requestMicrophoneAccess: async () => true,
		});
		expect(requestScreenAccess).toHaveBeenCalledOnce();
	});

	it("requests microphone access only when enabled and not already granted", async () => {
		const requestMicrophoneAccess = vi.fn(async () => true);
		await prepareNativeMacCapturePermissions(
			{ ...request, audio: { ...request.audio, microphone: { enabled: true, gain: 1 } } },
			{
				getStatus: (mediaType) => (mediaType === "screen" ? "granted" : "not-determined"),
				requestScreenAccess: async () => [],
				requestMicrophoneAccess,
			},
		);
		expect(requestMicrophoneAccess).toHaveBeenCalledOnce();
	});
});

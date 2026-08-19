// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeWebcamFormats = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../lib/webcamFormats", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/webcamFormats")>()),
	probeWebcamFormats,
}));

import { useCameraPreviewStream } from "./useCameraPreviewStream";

let originalMediaDevices: PropertyDescriptor | undefined;

function cameraStream() {
	const stop = vi.fn();
	const track = {
		stop,
		getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
	} as unknown as MediaStreamTrack;
	return {
		stream: {
			getTracks: () => [track],
			getVideoTracks: () => [track],
		} as unknown as MediaStream,
		stop,
	};
}

beforeEach(() => {
	originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	probeWebcamFormats.mockClear();
});

afterEach(() => {
	if (originalMediaDevices) {
		Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
	} else {
		Reflect.deleteProperty(navigator, "mediaDevices");
	}
	vi.restoreAllMocks();
});

describe("useCameraPreviewStream", () => {
	it("reuses a recorder-owned stream without acquiring or stopping the camera", async () => {
		const external = cameraStream();
		const getUserMedia = vi.fn();
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia },
		});

		const view = renderHook(() =>
			useCameraPreviewStream({ enabled: true, externalStream: external.stream }),
		);
		await waitFor(() => expect(view.result.current.stream).toBe(external.stream));
		view.unmount();

		expect(getUserMedia).not.toHaveBeenCalled();
		expect(external.stop).not.toHaveBeenCalled();
	});

	it("stops a temporary verification stream that it acquired", async () => {
		const owned = cameraStream();
		const getUserMedia = vi.fn(async () => owned.stream);
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia },
		});

		const view = renderHook(() => useCameraPreviewStream({ enabled: true }));
		await waitFor(() => expect(view.result.current.stream).toBe(owned.stream));
		view.unmount();

		expect(getUserMedia).toHaveBeenCalledOnce();
		expect(owned.stop).toHaveBeenCalledOnce();
	});
});

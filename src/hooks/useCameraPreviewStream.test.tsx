// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeWebcamFormatsCached = vi.hoisted(() =>
	vi.fn(async (): Promise<{ width: number; height: number; fps: number }[]> => []),
);

vi.mock("../lib/webcamFormats", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/webcamFormats")>()),
	probeWebcamFormatsCached,
}));

import { useCameraPreviewStream } from "./useCameraPreviewStream";

let originalMediaDevices: PropertyDescriptor | undefined;

function cameraStream() {
	const stop = vi.fn();
	let settings = { width: 1920, height: 1080, frameRate: 30 };
	const applyConstraints = vi.fn(async (constraints: MediaTrackConstraints) => {
		const width = (constraints.width as { exact?: number } | undefined)?.exact;
		const height = (constraints.height as { exact?: number } | undefined)?.exact;
		const fps = (constraints.frameRate as { ideal?: number } | undefined)?.ideal;
		if (width && height && fps) settings = { width, height, frameRate: fps };
	});
	const track = {
		stop,
		applyConstraints,
		getSettings: () => settings,
	} as unknown as MediaStreamTrack;
	return {
		stream: {
			getTracks: () => [track],
			getVideoTracks: () => [track],
		} as unknown as MediaStream,
		stop,
		applyConstraints,
	};
}

beforeEach(() => {
	originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	probeWebcamFormatsCached.mockReset();
	probeWebcamFormatsCached.mockResolvedValue([]);
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

	it("publishes supported formats and the active format in the same render", async () => {
		const external = cameraStream();
		const formats = [
			{ width: 3840, height: 2160, fps: 30 },
			{ width: 1920, height: 1080, fps: 30 },
		];
		probeWebcamFormatsCached.mockResolvedValue(formats);
		const seen: { supported: number; active: string }[] = [];

		const view = renderHook(() => {
			const result = useCameraPreviewStream({
				enabled: true,
				externalStream: external.stream,
				format: formats[0],
			});
			seen.push({
				supported: result.supportedFormats.length,
				active: `${result.activeFormat.width}@${result.activeFormat.fps}`,
			});
			return result;
		});
		await waitFor(() => expect(view.result.current.supportedFormats).toEqual(formats));

		expect(view.result.current.activeFormat).toEqual(formats[0]);
		expect(seen.some((frame) => frame.supported > 0 && frame.active !== "3840@30")).toBe(false);
		expect(external.applyConstraints).toHaveBeenCalledOnce();
		view.unmount();
	});

	it("does not reconfigure a track that already delivers the requested format", async () => {
		const external = cameraStream();
		const formats = [{ width: 1920, height: 1080, fps: 30 }];
		probeWebcamFormatsCached.mockResolvedValue(formats);

		const view = renderHook(() =>
			useCameraPreviewStream({ enabled: true, externalStream: external.stream }),
		);
		await waitFor(() => expect(view.result.current.supportedFormats).toEqual(formats));

		expect(external.applyConstraints).not.toHaveBeenCalled();
		view.unmount();
	});
});

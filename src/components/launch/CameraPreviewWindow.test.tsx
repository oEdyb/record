// @vitest-environment jsdom

import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraPreviewWindow } from "./CameraPreviewWindow";

const enabledPreferences = {
	micEnabled: true,
	micDeviceId: "mic-1",
	camEnabled: true,
	camDeviceId: "camera-1",
	camFormat: { width: 1920, height: 1080, fps: 60 },
	systemAudioEnabled: true,
	cursorCaptureMode: "editable-overlay" as const,
};

let preferencesChanged: ((preferences: typeof enabledPreferences) => void) | null = null;
let positionChanged: ((position: { x: number; y: number }) => void) | null = null;
const setCameraPreviewVisible = vi.fn();
const setCameraPreviewPosition = vi.fn();
const requestCameraPreviewConnection = vi.fn();
const transferFromImageBitmap = vi.fn();
let previewPort: {
	onmessage: ((event: MessageEvent) => void) | null;
	start: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	postMessage: ReturnType<typeof vi.fn>;
};

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
}

beforeEach(() => {
	vi.stubGlobal("localStorage", memoryStorage());
	localStorage.clear();
	preferencesChanged = null;
	positionChanged = null;
	setCameraPreviewVisible.mockClear();
	setCameraPreviewPosition.mockClear();
	requestCameraPreviewConnection.mockClear();
	transferFromImageBitmap.mockClear();
	previewPort = { onmessage: null, start: vi.fn(), close: vi.fn(), postMessage: vi.fn() };
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId) => {
		if (contextId === "bitmaprenderer") {
			return { transferFromImageBitmap } as unknown as ImageBitmapRenderingContext;
		}
		return null;
	});

	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			getRecordingPrefs: vi.fn(async () => enabledPreferences),
			onRecordingPrefsChanged: vi.fn((callback) => {
				preferencesChanged = callback;
				return vi.fn();
			}),
			onCameraPreviewPositionChanged: vi.fn((callback) => {
				positionChanged = callback;
				return vi.fn();
			}),
			setCameraPreviewVisible,
			requestCameraPreviewConnection,
			setCameraPreviewPosition,
		},
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function connectPreviewPort() {
	const event = new MessageEvent("message", {
		data: { type: "openscreen-camera-preview-port", role: "consumer" },
		source: window,
		ports: [previewPort as unknown as MessagePort],
	});
	window.dispatchEvent(event);
}

describe("CameraPreviewWindow", () => {
	it("shows the window and paints relayed frames whenever the camera is enabled", async () => {
		render(<CameraPreviewWindow />);

		await screen.findByTestId("camera-preview-loading");
		expect(requestCameraPreviewConnection).toHaveBeenCalledOnce();
		expect(screen.getByTestId("camera-preview-canvas")).toHaveAttribute("width", "576");
		expect(screen.getByTestId("camera-preview-canvas")).toHaveAttribute("height", "324");
		act(() => connectPreviewPort());
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		act(() => {
			previewPort.onmessage?.(new MessageEvent("message", { data: { type: "frame", bitmap } }));
		});

		expect(transferFromImageBitmap).toHaveBeenCalledWith(bitmap);
		expect(previewPort.postMessage).toHaveBeenCalledWith({ type: "consumed" });
		expect(screen.queryByTestId("camera-preview-loading")).not.toBeInTheDocument();
		await waitFor(() => expect(setCameraPreviewVisible).toHaveBeenCalledWith(true));
	});

	it("stays mounted but hides and releases its stream when the camera is disabled", async () => {
		render(<CameraPreviewWindow />);
		await screen.findByTestId("camera-preview-loading");

		act(() => {
			preferencesChanged?.({ ...enabledPreferences, camEnabled: false });
		});

		await waitFor(() => expect(setCameraPreviewVisible).toHaveBeenCalledWith(false));
		expect(screen.getByTestId("camera-preview-disabled")).toBeInTheDocument();
	});

	it("restores and saves only its private screen position", async () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ cameraPreviewPosition: { x: 401, y: 72 } }),
		);
		render(<CameraPreviewWindow />);

		await waitFor(() => {
			expect(setCameraPreviewPosition).toHaveBeenCalledWith({ x: 401, y: 72 });
		});
		act(() => positionChanged?.({ x: -212, y: 105 }));
		expect(JSON.parse(localStorage.getItem("openscreen_user_preferences") ?? "{}")).toMatchObject({
			cameraPreviewPosition: { x: -212, y: 105 },
		});
	});
});

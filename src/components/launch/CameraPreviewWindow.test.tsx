// @vitest-environment jsdom

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

let nativeExpanded: ((expanded: boolean) => void) | undefined;
let preferencesChanged: ((preferences: typeof enabledPreferences) => void) | null = null;
let positionChanged: ((position: { x: number; y: number }) => void) | null = null;
let sizeChanged: ((size: { width: number; height: number }) => void) | null = null;
const setCameraPreviewVisible = vi.fn();
const setCameraPreviewExpanded = vi.fn();
const setCameraPreviewPosition = vi.fn();
const setCameraPreviewSize = vi.fn();
const beginCameraPreviewResize = vi.fn();
const resizeCameraPreviewTo = vi.fn();
const endCameraPreviewResize = vi.fn();
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
	nativeExpanded = undefined;
	positionChanged = null;
	sizeChanged = null;
	setCameraPreviewVisible.mockClear();
	setCameraPreviewExpanded.mockClear();
	setCameraPreviewPosition.mockClear();
	setCameraPreviewSize.mockClear();
	beginCameraPreviewResize.mockClear();
	resizeCameraPreviewTo.mockClear();
	endCameraPreviewResize.mockClear();
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
			onCameraPreviewSizeChanged: vi.fn((callback) => {
				sizeChanged = callback;
				return vi.fn();
			}),
			setCameraPreviewVisible,
			setCameraPreviewExpanded,
			onCameraPreviewExpandedChanged: vi.fn((listener: (expanded: boolean) => void) => {
				nativeExpanded = listener;
				return vi.fn();
			}),
			requestCameraPreviewConnection,
			setCameraPreviewPosition,
			setCameraPreviewSize,
			beginCameraPreviewResize,
			resizeCameraPreviewTo,
			endCameraPreviewResize,
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

	it("expands through the main process and asks for a relay that matches the new window", async () => {
		vi.stubGlobal("devicePixelRatio", 2);
		vi.stubGlobal("innerWidth", 312);
		vi.stubGlobal("innerHeight", 186);
		render(<CameraPreviewWindow />);
		await screen.findByTestId("camera-preview-loading");
		act(() => connectPreviewPort());
		// A compact window never requests a relay: the default 2x frame already fits.
		expect(previewPort.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "configure" }),
		);

		const button = screen.getByTestId("camera-preview-expand");
		expect(button).toHaveAttribute("aria-label", "Expand camera preview");
		fireEvent.click(button);

		expect(setCameraPreviewExpanded).toHaveBeenCalledWith(true);
		expect(button).toHaveAttribute("aria-label", "Collapse camera preview");
		expect(screen.getByTestId("camera-preview-surface")).toHaveAttribute("data-expanded", "true");

		// The main process resizes the window; the resize event drives the relay request.
		act(() => {
			vi.stubGlobal("innerWidth", 1_734);
			vi.stubGlobal("innerHeight", 986);
			window.dispatchEvent(new Event("resize"));
		});
		expect(previewPort.postMessage).toHaveBeenCalledWith({
			type: "configure",
			width: 2_560,
			height: 1_440,
		});

		// A larger relayed bitmap resizes the canvas before it is painted.
		const bitmap = { width: 2_560, height: 1_440, close: vi.fn() } as unknown as ImageBitmap;
		act(() => {
			previewPort.onmessage?.(new MessageEvent("message", { data: { type: "frame", bitmap } }));
		});
		expect(screen.getByTestId("camera-preview-canvas")).toHaveAttribute("width", "2560");
		expect(screen.getByTestId("camera-preview-canvas")).toHaveAttribute("height", "1440");
		expect(transferFromImageBitmap).toHaveBeenCalledWith(bitmap);

		fireEvent.click(button);
		expect(setCameraPreviewExpanded).toHaveBeenLastCalledWith(false);
		expect(button).toHaveAttribute("aria-label", "Expand camera preview");
	});

	it("restores and saves the remembered compact size", async () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ cameraPreviewSize: { width: 504, height: 294 } }),
		);
		render(<CameraPreviewWindow />);

		await waitFor(() => {
			expect(setCameraPreviewSize).toHaveBeenCalledWith({ width: 504, height: 294 });
		});
		act(() => sizeChanged?.({ width: 600, height: 348 }));
		expect(JSON.parse(localStorage.getItem("openscreen_user_preferences") ?? "{}")).toMatchObject({
			cameraPreviewSize: { width: 600, height: 348 },
		});
	});

	it("resizes through the main process with total pointer travel from the grip", async () => {
		render(<CameraPreviewWindow />);
		await screen.findByTestId("camera-preview-loading");
		const grip = screen.getByTestId("camera-preview-resize");
		grip.setPointerCapture = vi.fn();
		grip.hasPointerCapture = vi.fn(() => true);
		grip.releasePointerCapture = vi.fn();

		fireEvent.pointerDown(grip, { button: 0, pointerId: 1, screenX: 100, screenY: 100 });
		expect(beginCameraPreviewResize).toHaveBeenCalledOnce();
		fireEvent.pointerMove(grip, { buttons: 1, pointerId: 1, screenX: 140, screenY: 110 });
		fireEvent.pointerMove(grip, { buttons: 1, pointerId: 1, screenX: 190, screenY: 130 });
		expect(resizeCameraPreviewTo).toHaveBeenNthCalledWith(1, 40, 10);
		expect(resizeCameraPreviewTo).toHaveBeenNthCalledWith(2, 90, 30);
		fireEvent.pointerUp(grip, { pointerId: 1 });
		expect(endCameraPreviewResize).toHaveBeenCalledOnce();

		fireEvent.doubleClick(grip);
		expect(setCameraPreviewSize).toHaveBeenLastCalledWith({ width: 312, height: 186 });

		// Expanded monitors fill the work area; there is nothing to drag.
		fireEvent.click(screen.getByTestId("camera-preview-expand"));
		expect(screen.queryByTestId("camera-preview-resize")).not.toBeInTheDocument();
	});

	it("hides on request and stays hidden while the camera still records", async () => {
		render(<CameraPreviewWindow />);
		await screen.findByTestId("camera-preview-loading");
		await waitFor(() => expect(setCameraPreviewVisible).toHaveBeenCalledWith(true));

		fireEvent.click(screen.getByTestId("camera-preview-hide"));

		await waitFor(() => expect(setCameraPreviewVisible).toHaveBeenLastCalledWith(false));
		expect(JSON.parse(localStorage.getItem("openscreen_user_preferences") ?? "{}")).toMatchObject({
			cameraMonitorHidden: true,
		});

		// The HUD's setup toggle writes the same preference from another window.
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ cameraMonitorHidden: false }),
		);
		act(() => {
			window.dispatchEvent(new Event("storage"));
		});
		await waitFor(() => expect(setCameraPreviewVisible).toHaveBeenLastCalledWith(true));
	});
});

it("can show a hidden monitor even when animation frames are suspended", async () => {
	vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
	localStorage.setItem(
		"openscreen_user_preferences",
		JSON.stringify({ cameraMonitorHidden: true }),
	);
	render(<CameraPreviewWindow />);
	await screen.findByTestId("camera-preview-loading");
	act(() => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ cameraMonitorHidden: false }),
		);
		window.dispatchEvent(new StorageEvent("storage"));
	});
	await waitFor(() => expect(setCameraPreviewVisible).toHaveBeenLastCalledWith(true));
});

it("shows Collapse after native maximize and requests a single restore", async () => {
	render(<CameraPreviewWindow />);
	await screen.findByTestId("camera-preview-loading");
	expect(nativeExpanded).toBeTypeOf("function");
	act(() => nativeExpanded?.(true));
	fireEvent.click(screen.getByRole("button", { name: "Collapse camera preview" }));
	expect(setCameraPreviewExpanded).toHaveBeenLastCalledWith(false);
});

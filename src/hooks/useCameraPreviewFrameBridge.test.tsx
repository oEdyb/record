// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraPreviewFrameBridge } from "./useCameraPreviewFrameBridge";

const originalRequestVideoFrameCallback = Object.getOwnPropertyDescriptor(
	HTMLVideoElement.prototype,
	"requestVideoFrameCallback",
);
const originalCancelVideoFrameCallback = Object.getOwnPropertyDescriptor(
	HTMLVideoElement.prototype,
	"cancelVideoFrameCallback",
);

class PreviewPort extends EventTarget {
	start = vi.fn();
	close = vi.fn();
	postMessage = vi.fn();
}

describe("useCameraPreviewFrameBridge", () => {
	let frameCallback: VideoFrameRequestCallback | null;
	let context: OffscreenCanvasRenderingContext2D;
	let bitmap: ImageBitmap;
	let transferToImageBitmap: ReturnType<typeof vi.fn>;
	let cancelVideoFrameCallback: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		frameCallback = null;
		bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		transferToImageBitmap = vi.fn(() => bitmap);
		context = {
			drawImage: vi.fn(),
			imageSmoothingEnabled: false,
			imageSmoothingQuality: "low",
		} as unknown as OffscreenCanvasRenderingContext2D;
		class StubOffscreenCanvas {
			width: number;
			height: number;
			constructor(width: number, height: number) {
				this.width = width;
				this.height = height;
			}
			getContext = vi.fn(() => context);
			transferToImageBitmap = transferToImageBitmap;
		}
		vi.stubGlobal("OffscreenCanvas", StubOffscreenCanvas);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
		vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(1_920);
		vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(1_080);
		Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
			configurable: true,
			value: vi.fn((callback: VideoFrameRequestCallback) => {
				frameCallback = callback;
				return 7;
			}),
		});
		cancelVideoFrameCallback = vi.fn(() => undefined);
		Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
			configurable: true,
			value: cancelVideoFrameCallback,
		});
	});

	afterEach(() => {
		if (originalRequestVideoFrameCallback) {
			Object.defineProperty(
				HTMLVideoElement.prototype,
				"requestVideoFrameCallback",
				originalRequestVideoFrameCallback,
			);
		} else {
			Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
		}
		if (originalCancelVideoFrameCallback) {
			Object.defineProperty(
				HTMLVideoElement.prototype,
				"cancelVideoFrameCallback",
				originalCancelVideoFrameCallback,
			);
		} else {
			Reflect.deleteProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback");
		}
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("relays one backpressured 2x Retina frame with high-quality downsampling", async () => {
		const port = new PreviewPort();
		const requestCameraPreviewConnection = vi.fn();
		const reportCapturePerformance = vi.fn();
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { requestCameraPreviewConnection, reportCapturePerformance },
		});
		const stream = {
			getVideoTracks: () => [{ id: "camera-track", getSettings: () => ({ frameRate: 30 }) }],
		} as unknown as MediaStream;
		const view = renderHook(() => useCameraPreviewFrameBridge(stream));
		expect(requestCameraPreviewConnection).toHaveBeenCalledOnce();

		act(() => {
			const event = new MessageEvent("message", {
				data: { type: "openscreen-camera-preview-port", role: "producer" },
				source: window,
			});
			Object.defineProperty(event, "ports", { value: [port] });
			window.dispatchEvent(event);
		});
		await waitFor(() => expect(frameCallback).not.toBeNull());

		const metadata = (mediaTime: number, presentedFrames: number) =>
			({ mediaTime, presentedFrames }) as VideoFrameCallbackMetadata;
		act(() => frameCallback?.(100, metadata(0, 1)));
		expect(context.imageSmoothingEnabled).toBe(true);
		expect(context.imageSmoothingQuality).toBe("high");
		expect(context.drawImage).toHaveBeenCalledWith(
			expect.any(HTMLVideoElement),
			0,
			0,
			1_920,
			1_080,
			0,
			0,
			576,
			324,
		);
		expect(port.postMessage).toHaveBeenCalledWith({ type: "frame", bitmap }, [bitmap]);

		act(() => frameCallback?.(200, metadata(1 / 30, 2)));
		expect(transferToImageBitmap).toHaveBeenCalledTimes(1);
		act(() => port.dispatchEvent(new MessageEvent("message", { data: { type: "consumed" } })));
		act(() => frameCallback?.(230, metadata(2 / 30, 3)));
		expect(transferToImageBitmap).toHaveBeenCalledTimes(2);
		act(() => port.dispatchEvent(new MessageEvent("message", { data: { type: "consumed" } })));
		act(() => frameCallback?.(250, metadata(3 / 30, 4)));
		expect(transferToImageBitmap).toHaveBeenCalledTimes(2);
		act(() => frameCallback?.(280, metadata(4 / 30, 5)));
		expect(transferToImageBitmap).toHaveBeenCalledTimes(3);
		act(() => frameCallback?.(5_100, metadata(5, 151)));
		expect(reportCapturePerformance).toHaveBeenCalledWith({
			cameraDeliveredFps: (5 * 1_000) / 5_000,
			cameraTimestampDriftMs: 0,
		});

		view.unmount();
		expect(cancelVideoFrameCallback).toHaveBeenCalledWith(7);
		expect(port.postMessage).toHaveBeenLastCalledWith({ type: "clear" });
	});

	it("relays at the size the monitor configures, within the 1440p cap", async () => {
		const port = new PreviewPort();
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { requestCameraPreviewConnection: vi.fn(), reportCapturePerformance: vi.fn() },
		});
		const stream = {
			getVideoTracks: () => [{ id: "camera-track", getSettings: () => ({ frameRate: 30 }) }],
		} as unknown as MediaStream;
		const view = renderHook(() => useCameraPreviewFrameBridge(stream));
		act(() => {
			const event = new MessageEvent("message", {
				data: { type: "openscreen-camera-preview-port", role: "producer" },
				source: window,
			});
			Object.defineProperty(event, "ports", { value: [port] });
			window.dispatchEvent(event);
		});
		await waitFor(() => expect(frameCallback).not.toBeNull());
		const metadata = (mediaTime: number, presentedFrames: number) =>
			({ mediaTime, presentedFrames }) as VideoFrameCallbackMetadata;

		act(() =>
			port.dispatchEvent(
				new MessageEvent("message", { data: { type: "configure", width: 4_000, height: 2_250 } }),
			),
		);
		act(() => frameCallback?.(100, metadata(0, 1)));
		expect(context.drawImage).toHaveBeenLastCalledWith(
			expect.any(HTMLVideoElement),
			0,
			0,
			1_920,
			1_080,
			0,
			0,
			2_560,
			1_440,
		);
		// Resizing the canvas resets the context; smoothing must be re-applied.
		expect(context.imageSmoothingQuality).toBe("high");

		act(() => port.dispatchEvent(new MessageEvent("message", { data: { type: "consumed" } })));
		act(() =>
			port.dispatchEvent(
				new MessageEvent("message", { data: { type: "configure", width: 100, height: 50 } }),
			),
		);
		act(() => frameCallback?.(200, metadata(1 / 30, 2)));
		expect(context.drawImage).toHaveBeenLastCalledWith(
			expect.any(HTMLVideoElement),
			0,
			0,
			1_920,
			1_080,
			0,
			0,
			576,
			324,
		);
		view.unmount();
	});
});

import { usePreviewPreferences } from "@/lib/ai-edition/store/previewPreferences";
// @vitest-environment jsdom
/**
 * The fatal-error channel (PR #162).
 *
 * `createView` returns an id long before the native render thread can fail, so a host
 * that cannot create a D3D11 device used to leave the user with a black canvas and an
 * `eprintln!` nobody reads. The addon now reports the dead thread through `readFrame`,
 * and this hook turns that into `error`.
 *
 * The half worth guarding is the negative one: `readFrame` also rejects when there is no
 * Electron bridge at all (pure web `npm run dev`, jsdom), and the addon being absent is a
 * normal no-op, not a failure. Neither may raise the banner.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createCompositorView: vi.fn(),
	readCompositorFrame: vi.fn(),
	destroyCompositorView: vi.fn(),
	reportCompositorPreviewTiming: vi.fn(),
	setCompositorRect: vi.fn(),
	commandListeners: new Set<(playing: boolean | undefined) => void>(),
}));

vi.mock("../compositorViewClient", () => ({
	createCompositorView: mocks.createCompositorView,
	readCompositorFrame: mocks.readCompositorFrame,
	destroyCompositorView: mocks.destroyCompositorView,
	reportCompositorPreviewTiming: mocks.reportCompositorPreviewTiming,
	setCompositorParam: vi.fn(),
	setCompositorPlaying: vi.fn(),
	setCompositorRect: mocks.setCompositorRect,
	onCompositorCommand: (listener: (playing: boolean | undefined) => void) => {
		mocks.commandListeners.add(listener);
		return () => mocks.commandListeners.delete(listener);
	},
}));

const sendCommand = (playing?: boolean) => {
	for (const listener of mocks.commandListeners) listener(playing);
};

import { useNativeCompositorView } from "./useNativeCompositorView";

// jsdom ships no ResizeObserver; the hook constructs one to track the canvas box.
// Nothing here observes anything — these tests only exercise the pull loop.
globalThis.ResizeObserver = class {
	observe() {
		// inert on purpose: the canvas box never changes in these tests
	}
	unobserve() {
		// see observe()
	}
	disconnect() {
		// see observe()
	}
} as unknown as typeof ResizeObserver;

/** A canvas with a stubbed 2D context — jsdom has none, and the pull loop bails without it. */
function stubCanvasRef(): { current: HTMLCanvasElement } {
	const canvas = document.createElement("canvas");
	canvas.getContext = vi.fn(() => ({
		drawImage: vi.fn(),
		putImageData: vi.fn(),
	})) as unknown as HTMLCanvasElement["getContext"];
	return { current: canvas };
}

const DEVICE_FAILURE =
	"this display adapter has no D3D11 video decoder (0x887A0004). OpenScreen decodes every preview and export frame with D3D11VA";

describe("useNativeCompositorView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usePreviewPreferences.setState({ quality: "performance" });
		mocks.setCompositorRect.mockResolvedValue({ ok: true });
		vi.unstubAllGlobals();
		mocks.reportCompositorPreviewTiming.mockResolvedValue({ ok: true });
		mocks.destroyCompositorView.mockResolvedValue({ ok: true });
	});

	function controlledFrames() {
		let nextId = 0;
		const scheduled = new Map<number, FrameRequestCallback>();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			scheduled.set(++nextId, callback);
			return nextId;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => scheduled.delete(id));
		vi.stubGlobal("ImageData", class {});
		return async (timestamp: number) => {
			await act(async () => {
				const callbacks = [...scheduled.values()];
				scheduled.clear();
				for (const callback of callbacks) callback(timestamp);
			});
		};
	}

	it.each([60, 120, 144])("caps preview polling at 60 Hz on a %i Hz display", async (hz) => {
		const frame = controlledFrames();
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue(null);
		const ref = stubCanvasRef();
		const view = renderHook(() => useNativeCompositorView(ref));
		await act(async () => undefined);
		for (let tick = 0; tick < hz; tick += 1) await frame((tick * 1000) / hz);
		expect(mocks.readCompositorFrame.mock.calls.length).toBeGreaterThanOrEqual(59);
		expect(mocks.readCompositorFrame.mock.calls.length).toBeLessThanOrEqual(61);
		view.unmount();
	});

	it("polls at 10 Hz once a paused preview has been unchanged for a second", async () => {
		const frame = controlledFrames();
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue(null);
		const view = renderHook(() => useNativeCompositorView(stubCanvasRef()));
		await act(async () => undefined);
		const pullsDuring = async (fromMs: number, toMs: number) => {
			const before = mocks.readCompositorFrame.mock.calls.length;
			for (let t = fromMs; t < toMs; t += 1000 / 60) await frame(t);
			return mocks.readCompositorFrame.mock.calls.length - before;
		};

		expect(await pullsDuring(0, 1000)).toBeGreaterThanOrEqual(59);
		const idlePulls = await pullsDuring(1000, 2000);
		expect(idlePulls).toBeGreaterThanOrEqual(9);
		expect(idlePulls).toBeLessThanOrEqual(11);
		sendCommand();
		expect(await pullsDuring(2000, 2500)).toBeGreaterThanOrEqual(29);
		sendCommand(true);
		await pullsDuring(2500, 4000);
		expect(await pullsDuring(4000, 5000)).toBeGreaterThanOrEqual(59);
		view.unmount();
		expect(mocks.commandListeners.size).toBe(0);
	});

	it("waits for presentation before requesting and reporting another frame", async () => {
		const frame = controlledFrames();
		let finishBitmap: (bitmap: ImageBitmap) => void = () => undefined;
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(
				() =>
					new Promise<ImageBitmap>((resolve) => {
						finishBitmap = resolve;
					}),
			),
		);
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue({
			gen: 1,
			width: 1,
			height: 1,
			data: new Uint8Array(4),
			sourceTimeSec: 1,
			clipIndex: 0,
			transportGeneration: 1,
		});
		const onFrame = vi.fn();
		const ref = stubCanvasRef();
		const view = renderHook(() => useNativeCompositorView(ref, { onFrame }));
		await act(async () => undefined);
		await frame(0);
		await frame(34);
		await frame(68);
		await frame(102);
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(1);
		expect(onFrame).not.toHaveBeenCalled();
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		await act(async () => finishBitmap(bitmap));
		expect(onFrame).toHaveBeenCalledTimes(1);
		expect(bitmap.close).toHaveBeenCalledOnce();
		view.unmount();
	});

	it("closes a late bitmap without drawing or reporting after unmount", async () => {
		const frame = controlledFrames();
		let finishBitmap: (bitmap: ImageBitmap) => void = () => undefined;
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(
				() =>
					new Promise<ImageBitmap>((resolve) => {
						finishBitmap = resolve;
					}),
			),
		);
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue({
			gen: 1,
			width: 1,
			height: 1,
			data: new Uint8Array(4),
			sourceTimeSec: 1,
			clipIndex: 0,
			transportGeneration: 1,
		});
		const onFrame = vi.fn();
		const ref = stubCanvasRef();
		const context = { drawImage: vi.fn(), putImageData: vi.fn() };
		ref.current.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement["getContext"];
		const view = renderHook(() => useNativeCompositorView(ref, { onFrame }));
		await act(async () => undefined);
		await frame(0);
		await frame(34);
		view.unmount();
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		await act(async () => finishBitmap(bitmap));
		expect(context.drawImage).not.toHaveBeenCalled();
		expect(onFrame).not.toHaveBeenCalled();
		expect(bitmap.close).toHaveBeenCalledOnce();
	});

	it("falls back to RGBA drawing when bitmap creation rejects", async () => {
		const frame = controlledFrames();
		vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bitmap unavailable")));
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue({
			gen: 1,
			width: 1,
			height: 1,
			data: new Uint8Array(4),
			sourceTimeSec: 1,
			clipIndex: 0,
			transportGeneration: 1,
		});
		const ref = stubCanvasRef();
		const context = { drawImage: vi.fn(), putImageData: vi.fn() };
		ref.current.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement["getContext"];
		const onFrame = vi.fn();
		const view = renderHook(() => useNativeCompositorView(ref, { onFrame }));
		await act(async () => undefined);
		await frame(0);
		expect(context.putImageData).toHaveBeenCalledOnce();
		expect(context.drawImage).not.toHaveBeenCalled();
		expect(onFrame).toHaveBeenCalledOnce();
		expect(view.result.current.error).toBeNull();
		view.unmount();
	});

	it("keeps the painted frame until a resized replacement is ready", async () => {
		const tick = controlledFrames();
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		const context = { drawImage: vi.fn(), putImageData: vi.fn() };
		const ref = stubCanvasRef();
		ref.current.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement["getContext"];
		ref.current.getBoundingClientRect = () => ({ left: 0, top: 0, width: 2, height: 2 }) as DOMRect;
		const first = { close: vi.fn() } as unknown as ImageBitmap;
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(first));
		mocks.readCompositorFrame.mockResolvedValue({
			gen: 1,
			width: 2,
			height: 2,
			data: new Uint8Array(16),
			sourceTimeSec: 1,
			clipIndex: 0,
			transportGeneration: 1,
		});
		const view = renderHook(() => useNativeCompositorView(ref));
		await act(async () => undefined);
		await tick(0);
		expect(context.drawImage).toHaveBeenCalledWith(first, 0, 0);
		mocks.readCompositorFrame.mockResolvedValue(null);
		ref.current.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4, height: 4 }) as DOMRect;
		window.dispatchEvent(new Event("resize"));
		await tick(34);
		expect(mocks.setCompositorRect).toHaveBeenLastCalledWith(7, {
			x: 0,
			y: 0,
			width: 4,
			height: 4,
		});
		// Changing these properties erases the visible canvas, even before the next frame arrives.
		expect(ref.current.width).toBe(2);
		expect(ref.current.height).toBe(2);
		let ready!: (bitmap: ImageBitmap) => void;
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(
				() =>
					new Promise<ImageBitmap>((resolve) => {
						ready = resolve;
					}),
			),
		);
		mocks.readCompositorFrame.mockResolvedValue({
			gen: 2,
			width: 4,
			height: 4,
			data: new Uint8Array(64),
			sourceTimeSec: 1,
			clipIndex: 0,
			transportGeneration: 1,
		});
		await tick(68);
		expect(ref.current.width).toBe(2);
		const replacement = { close: vi.fn() } as unknown as ImageBitmap;
		await act(async () => ready(replacement));
		expect(ref.current.width).toBe(4);
		expect(ref.current.height).toBe(4);
		expect(context.drawImage).toHaveBeenLastCalledWith(replacement, 0, 0);
		view.unmount();
	});

	it("discards an outstanding bitmap when the preview is resized", async () => {
		const frame = controlledFrames();
		let finishBitmap: (bitmap: ImageBitmap) => void = () => undefined;
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(
				() =>
					new Promise<ImageBitmap>((resolve) => {
						finishBitmap = resolve;
					}),
			),
		);
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue({
			gen: 1,
			width: 1,
			height: 1,
			data: new Uint8Array(4),
			sourceTimeSec: 1,
			clipIndex: 0,
			transportGeneration: 1,
		});
		const ref = stubCanvasRef();
		ref.current.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect;
		const context = { drawImage: vi.fn(), putImageData: vi.fn() };
		ref.current.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement["getContext"];
		const onFrame = vi.fn();
		const view = renderHook(() => useNativeCompositorView(ref, { onFrame }));
		await act(async () => undefined);
		await frame(0);
		ref.current.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 450 }) as DOMRect;
		window.dispatchEvent(new Event("resize"));
		await frame(34);
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		await act(async () => finishBitmap(bitmap));
		expect(ref.current.width).toBe(640);
		expect(ref.current.height).toBe(360);
		expect(context.drawImage).not.toHaveBeenCalled();
		expect(onFrame).not.toHaveBeenCalled();
		expect(bitmap.close).toHaveBeenCalledOnce();
		view.unmount();
	});

	it("reports the exact native frame timing after validating the packet", async () => {
		vi.stubGlobal(
			"ImageData",
			class {
				constructor(
					readonly data: Uint8ClampedArray,
					readonly width: number,
					readonly height: number,
				) {}
			},
		);
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ close: vi.fn() }));
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValueOnce({
			gen: 4,
			width: 1,
			height: 1,
			data: Buffer.from([0, 0, 0, 255]),
			sourceTimeSec: 1.25,
			clipIndex: 2,
			transportGeneration: 9,
			readbackMs: 0.4,
		});
		mocks.readCompositorFrame.mockResolvedValue(null);
		const onFrame = vi.fn();
		const ref = stubCanvasRef();

		renderHook(() =>
			useNativeCompositorView(ref, {
				sources: { screenPath: "rec.mp4" },
				onFrame,
			}),
		);

		await waitFor(() =>
			expect(onFrame).toHaveBeenCalledWith({
				sourceTimeSec: 1.25,
				clipIndex: 2,
				transportGeneration: 9,
			}),
		);
	});

	it("creates a Performance preview at the visible CSS size", async () => {
		vi.stubGlobal("devicePixelRatio", 2);
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue(null);
		const ref = stubCanvasRef();
		ref.current.getBoundingClientRect = vi.fn(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 1280,
			bottom: 720,
			width: 1280,
			height: 720,
			toJSON: vi.fn(),
		}));

		renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));

		await waitFor(() =>
			expect(mocks.createCompositorView).toHaveBeenCalledWith(
				{ x: 0, y: 0, width: 1280, height: 720 },
				{ screenPath: "rec.mp4" },
			),
		);
	});

	it("changes quality on the current decoder and follows display density", async () => {
		const frame = controlledFrames();
		vi.stubGlobal("devicePixelRatio", 2);
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue(null);
		const ref = stubCanvasRef();
		vi.spyOn(ref.current, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			width: 640,
			height: 360,
		} as DOMRect);
		const view = renderHook(() => useNativeCompositorView(ref));
		await act(async () => undefined);
		act(() => usePreviewPreferences.getState().setQuality("sharp"));
		await frame(40);
		expect(mocks.setCompositorRect).toHaveBeenLastCalledWith(7, {
			x: 0,
			y: 0,
			width: 1280,
			height: 720,
		});
		expect(mocks.createCompositorView).toHaveBeenCalledTimes(1);
		expect(mocks.destroyCompositorView).not.toHaveBeenCalled();
		act(() => usePreviewPreferences.getState().setQuality("performance"));
		await frame(80);
		expect(mocks.setCompositorRect).toHaveBeenLastCalledWith(7, {
			x: 0,
			y: 0,
			width: 640,
			height: 360,
		});
		view.unmount();
	});
	it("applies a quality change made while native creation is pending", async () => {
		const frame = controlledFrames();
		vi.stubGlobal("devicePixelRatio", 2);
		let resolveCreate!: (value: { id: number }) => void;
		mocks.createCompositorView.mockReturnValue(
			new Promise((resolve) => {
				resolveCreate = resolve;
			}),
		);
		mocks.readCompositorFrame.mockResolvedValue(null);
		const ref = stubCanvasRef();
		vi.spyOn(ref.current, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			width: 640,
			height: 360,
		} as DOMRect);
		const view = renderHook(() => useNativeCompositorView(ref));
		act(() => usePreviewPreferences.getState().setQuality("sharp"));
		await frame(40);
		await act(async () => resolveCreate({ id: 7 }));
		expect(mocks.setCompositorRect).toHaveBeenLastCalledWith(7, {
			x: 0,
			y: 0,
			width: 1280,
			height: 720,
		});
		view.unmount();
	});

	it("surfaces the native message when the render thread dies", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
	});

	it("stops polling once the error is terminal — the thread never restarts", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
		const callsAtFailure = mocks.readCompositorFrame.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(callsAtFailure);
	});

	it("stays quiet when the addon is absent (synthetic id, no frames, no error)", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: -1 });
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.readCompositorFrame).toHaveBeenCalled());
		expect(result.current.error).toBeNull();
	});

	it("stays quiet without an Electron bridge — no view id, so nothing is ever polled", async () => {
		mocks.createCompositorView.mockRejectedValue(new Error("Native bridge unavailable."));
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.createCompositorView).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).not.toHaveBeenCalled();
		expect(result.current.error).toBeNull();
	});

	it("releases the native view while the editor window is hidden", async () => {
		mocks.createCompositorView.mockResolvedValueOnce({ id: 7 }).mockResolvedValueOnce({ id: 8 });
		mocks.readCompositorFrame.mockResolvedValue(null);
		const ref = stubCanvasRef();

		renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));
		await waitFor(() => expect(mocks.createCompositorView).toHaveBeenCalledTimes(1));

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await waitFor(() => expect(mocks.destroyCompositorView).toHaveBeenCalledWith(7));

		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await waitFor(() => expect(mocks.createCompositorView).toHaveBeenCalledTimes(2));
	});
});

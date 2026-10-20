/**
 * React hook that drives a canvas-based preview of the native D3D11
 * compositor. The compositor renders OFFSCREEN (no OS window), so this hook:
 *   1. Allocates an offscreen compositor view sized to the canvas's visible CSS
 *      rect (measured via ResizeObserver + window resize/scroll, rAF-coalesced
 *      — the exact same sync machinery as before, repurposed: it now drives
 *      the offscreen render-target resolution instead of a window position).
 *   2. Polls `readCompositorFrame` at most 30 times per second, passing the
 *      generation it last painted. Native returns a self-describing packet
 *      (`{ gen, width, height, data }`) ONLY when a newer frame exists — otherwise
 *      `null`, and the canvas is left untouched. So while the preview sits still
 *      (paused editing) nothing is cloned, sent over IPC, or repainted. The canvas
 *      drawing buffer is sized from the packet's own dims, so pixels and canvas
 *      can never drift apart.
 *
 * Every native-bridge call is wrapped in a try/catch that swallows + warns,
 * because the renderer may run without the bridge (pure web `npm run dev`,
 * Vitest jsdom env). The hook never throws upward.
 */

import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { noteUiProbePreviewFrame } from "@/lib/ai-edition/perf/uiFrameProbe";
import { usePreviewPreferences } from "@/lib/ai-edition/store/previewPreferences";
import {
	createCompositorView,
	destroyCompositorView,
	onCompositorCommand,
	readCompositorFrame,
	reportCompositorPreviewTiming,
	setCompositorParam,
	setCompositorPlaying,
	setCompositorRect,
} from "../compositorViewClient";
import type { CompositorFrameTiming, CompositorParamValue, CompositorViewRect } from "../contracts";
import { computePreviewRect, rectsEqual } from "../nativeViewRect";
import { notePreviewPaintedFrame } from "../previewSettledFrames";

export interface UseNativeCompositorViewOptions {
	/** When false, the hook does nothing on mount and destroys nothing on
	 * unmount. Defaults to true. */
	enabled?: boolean;
	/** F3: real recording sources (screen + webcam H264 files + cursor telemetry).
	 * Omitted → the native side falls back to the POC fixture. Read once at view
	 * creation, so resolve them before enabling the hook to avoid a fixture→real
	 * re-create. */
	sources?: { screenPath?: string; webcamPath?: string; cursorPath?: string };
	/** Receives the source PTS and transport identity of each validated native frame. */
	onFrame?: (frame: CompositorFrameTiming) => void;
}

export interface UseNativeCompositorViewResult {
	/** Numeric view id once createCompositorView resolves. `null` while the
	 * call is in flight or when the bridge is unavailable. May be a negative
	 * synthetic id when the native addon is absent (see
	 * `compositorViewService`). */
	viewId: number | null;
	setParam: (key: string, value: CompositorParamValue) => void;
	setPlaying: (playing: boolean) => void;
	/**
	 * Native message from a render thread that died — no D3D11 device on this host,
	 * a decoder that refused the recording, etc. `null` while things work AND in every
	 * environment without the native path (pure web `npm run dev`, jsdom): the pull
	 * loop that produces this only runs once a real `viewId` exists, so an absent
	 * bridge or addon reads as "no frames", never as an error.
	 *
	 * Terminal: the render thread does not restart, so the pull loop stops with it.
	 * Callers show it instead of the canvas — it is the only thing that distinguishes
	 * "this machine cannot run the compositor" from a preview that is merely black.
	 */
	error: string | null;
}

/** swallow+warn wrapper for native-bridge calls. The renderer can run without
 * a preload `electronAPI` (jsdom, pure web); errors must never propagate. */
function safelyCall(label: string, call: () => Promise<unknown>) {
	try {
		call().catch((error: unknown) => {
			console.warn(`[compositor-view] ${label} failed:`, error);
		});
	} catch (error) {
		console.warn(`[compositor-view] ${label} failed:`, error);
	}
}

/** Use the rAF timestamp: displays can run at 60, 120, or 144 Hz. */
const PREVIEW_FRAME_INTERVAL_MS = 1000 / 60;
/** While paused and untouched, an empty pull costs a main-process round trip
 *  for nothing. After a second without a new frame or command, poll at 10 Hz
 *  from a timer; the next command or frame restores 60 Hz display frames. */
const IDLE_PREVIEW_FRAME_INTERVAL_MS = 100;
const EMPTY_PULLS_BEFORE_IDLE = 60;

export function useNativeCompositorView(
	canvasRef: RefObject<HTMLCanvasElement>,
	opts: UseNativeCompositorViewOptions = {},
): UseNativeCompositorViewResult {
	const enabled = opts.enabled !== false;
	const [documentVisible, setDocumentVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	// Re-create the native view when the screen source changes (e.g. loading a different
	// project) so it never keeps showing a stale clip.
	const screenPath = opts.sources?.screenPath;
	const onFrameRef = useRef(opts.onFrame);
	onFrameRef.current = opts.onFrame;
	const [viewId, setViewId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Mirror into a ref so async callbacks always see the freshest id without
	// re-subscribing the main effect.
	const viewIdRef = useRef<number | null>(null);
	viewIdRef.current = viewId;

	useEffect(() => {
		if (typeof document === "undefined") return;
		const handleVisibilityChange = () => setDocumentVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, []);

	const active = enabled && documentVisible;

	// Recreate only when the screen decoder identity changes. Camera and cursor changes
	// travel through the active transport/scene paths and must not destroy the view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: screenPath is the intentional source identity
	useEffect(() => {
		if (!active) {
			setViewId(null);
			return;
		}
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}

		let rectRafHandle = 0;
		let pullRafHandle = 0;
		let nextPullAt = 0;
		let rectGeneration = 0;
		let lastRect: CompositorViewRect | null = null;
		let disposed = false;
		let nativeViewId: number | null = null;
		let timingFlushHandle = 0;
		let longTaskObserver: PerformanceObserver | null = null;
		let timingBatch = {
			ipcMs: [] as number[],
			drawMs: [] as number[],
			browserMainThreadMs: [] as number[],
		};
		const recordTiming = (key: keyof typeof timingBatch, value: number) => {
			if (!Number.isFinite(value) || value < 0 || value > 60_000) return;
			const samples = timingBatch[key];
			if (samples.length >= 300) samples.shift();
			samples.push(value);
		};
		const flushTiming = async (id = nativeViewId) => {
			if (id == null) return;
			const batch = timingBatch;
			if (
				batch.ipcMs.length === 0 &&
				batch.drawMs.length === 0 &&
				batch.browserMainThreadMs.length === 0
			) {
				return;
			}
			timingBatch = { ipcMs: [], drawMs: [], browserMainThreadMs: [] };
			await reportCompositorPreviewTiming(id, batch);
		};
		if (
			typeof PerformanceObserver !== "undefined" &&
			PerformanceObserver.supportedEntryTypes?.includes("longtask")
		) {
			longTaskObserver = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					recordTiming("browserMainThreadMs", entry.duration);
				}
			});
			longTaskObserver.observe({ type: "longtask" });
		}
		timingFlushHandle = window.setInterval(() => {
			safelyCall("reportPreviewTiming", () => flushTiming());
		}, 5_000);
		// Fresh view (source or enablement changed) → the previous view's fatal error
		// says nothing about this one.
		setError(null);

		/** Resize the canvas's DRAWING BUFFER to match the offscreen render
		 *  target's pixel dimensions. Setting `canvas.width` / `canvas.height`
		 *  is destructive (clears the bitmap), so we only do it on genuine
		 *  initial creation. Later resizes happen only when a frame is ready. */
		const syncCanvasSize = (rect: CompositorViewRect) => {
			if (canvas.width !== rect.width) {
				canvas.width = rect.width;
			}
			if (canvas.height !== rect.height) {
				canvas.height = rect.height;
			}
		};

		const applyRectNow = () => {
			rectRafHandle = 0;
			if (disposed) {
				return;
			}
			// Apply the current viewing preference without recreating the decoder.
			const domRect = canvas.getBoundingClientRect();
			const next = computePreviewRect(
				domRect,
				usePreviewPreferences.getState().quality,
				window.devicePixelRatio,
			);
			// `x` / `y` are vestigial in the new contract (ignored native-side),
			// but `rectsEqual` still compares them — harmless: scrolling will just
			// re-push the rect, and the native side ignores x/y.
			if (lastRect && rectsEqual(lastRect, next)) {
				return;
			}
			lastRect = next;
			rectGeneration += 1;
			const id = viewIdRef.current;
			if (id == null) {
				return;
			}
			// Keep the last painted frame visible while native renders the new size.
			// The accepted-frame path resizes and paints together, without yielding.
			safelyCall("setRect", () => setCompositorRect(id, next));
		};

		const scheduleRectUpdate = () => {
			if (rectRafHandle !== 0) {
				return;
			}
			rectRafHandle = requestAnimationFrame(applyRectNow);
		};

		// Generation of the last frame we painted. The native side only publishes a
		// NEW generation when it actually composed a new frame (it never republishes
		// an identical one), so passing this back as `sinceGen` means an unchanged
		// frame is never re-delivered: no clone, no IPC, no canvas copy while the
		// preview sits still (paused editing — the dominant case). `0` = "painted
		// nothing yet", which forces delivery of the first frame.
		let lastGen = 0;
		let playing = false;
		let emptyPulls = 0;
		let idleTimer = 0;
		const unsubscribeCommands = onCompositorCommand((nextPlaying) => {
			if (nextPlaying !== undefined) playing = nextPlaying;
			emptyPulls = 0;
			nextPullAt = 0;
			if (idleTimer !== 0) {
				window.clearTimeout(idleTimer);
				idleTimer = 0;
				pullRafHandle = requestAnimationFrame(pullLoop);
			}
		});
		/** Paused and unchanged, the next pull waits on a timer instead of the next
		 *  display frame: a requestAnimationFrame request alone keeps Chromium
		 *  producing frames 60 times a second. */
		const scheduleNextPull = () => {
			if (!playing && emptyPulls >= EMPTY_PULLS_BEFORE_IDLE) {
				idleTimer = window.setTimeout(() => {
					idleTimer = 0;
					nextPullAt = 0;
					pullRafHandle = requestAnimationFrame(pullLoop);
				}, IDLE_PREVIEW_FRAME_INTERVAL_MS);
			} else {
				pullRafHandle = requestAnimationFrame(pullLoop);
			}
		};
		// Keep the entire read → bitmap → paint operation in flight. Releasing
		// after IPC alone lets bitmap promises finish and paint out of order.
		let inFlight = false;

		/** rAF pull loop: throttle to ~60fps and repaint ONLY when native reports a
		 *  newer generation. The returned packet is self-describing (`gen` + dims +
		 *  pixels), so the canvas is sized from the packet — pixels and canvas can
		 *  never drift out of sync. Native rendering runs on its own thread. */
		const pullLoop = (timestamp: number) => {
			pullRafHandle = 0;
			scheduleNextPull();
			if (disposed || inFlight) {
				return;
			}
			if (timestamp + 0.1 < nextPullAt) {
				return;
			}
			const id = viewIdRef.current;
			if (id == null) {
				return;
			}
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return;
			}
			const interval =
				!playing && emptyPulls >= EMPTY_PULLS_BEFORE_IDLE
					? IDLE_PREVIEW_FRAME_INTERVAL_MS
					: PREVIEW_FRAME_INTERVAL_MS;
			nextPullAt = timestamp + interval - (Math.max(0, timestamp - nextPullAt) % interval);
			inFlight = true;
			const requestedRectGeneration = rectGeneration;
			const readStartedAt = performance.now();
			readCompositorFrame(id, lastGen)
				.then(async (frame) => {
					recordTiming("ipcMs", performance.now() - readStartedAt);
					emptyPulls = frame ? 0 : emptyPulls + 1;
					// `null` = nothing newer than `lastGen` (idle path — no pixels
					// crossed IPC) OR no frame yet. Either way, leave the canvas as-is.
					if (disposed || !frame || requestedRectGeneration !== rectGeneration) {
						return;
					}
					const { gen, width, height, data, sourceTimeSec, clipIndex, transportGeneration } = frame;
					// Defensive: the packet's byte count must match its own declared
					// dimensions. A mismatch would corrupt the image silently — bail.
					if (data.byteLength !== width * height * 4 || width === 0 || height === 0) {
						return;
					}
					// Wrap the received buffer DIRECTLY — no intermediate copy. `data` is a
					// fresh per-frame Buffer from IPC (never pooled or reused across frames),
					// so a view over it is valid for the lifetime of this paint, and nothing
					// mutates it. Cast to `ArrayBuffer` because `ImageData` rejects
					// `SharedArrayBuffer`-backed arrays (IPC binary is never shared).
					const drawStartedAt = performance.now();
					const pixels = new Uint8ClampedArray(
						data.buffer as ArrayBuffer,
						data.byteOffset,
						data.byteLength,
					);
					const image = new ImageData(pixels, width, height);
					let bitmap: ImageBitmap | null = null;
					try {
						if (typeof createImageBitmap === "function") bitmap = await createImageBitmap(image);
					} catch {
						// A bitmap decode failure can still use the complete RGBA packet.
					}
					try {
						if (disposed || requestedRectGeneration !== rectGeneration) return;
						// Resize only when the accepted frame is ready to paint. A pending
						// bitmap must not clear the previous frame or undo a newer resize.
						if (canvas.width !== width) canvas.width = width;
						if (canvas.height !== height) canvas.height = height;
						if (bitmap) ctx.drawImage(bitmap, 0, 0);
						else ctx.putImageData(image, 0, 0);
						recordTiming("drawMs", performance.now() - drawStartedAt);
					} finally {
						bitmap?.close();
					}
					lastGen = gen;
					notePreviewPaintedFrame({ viewId: id, sourceTimeSec, clipIndex, transportGeneration });
					onFrameRef.current?.({ sourceTimeSec, clipIndex, transportGeneration });
					// Sonde de fluidité : signale qu'une frame a réellement été livrée, pour
					// que les intervalles rAF soient rangés dans l'état « preview active »
					// plutôt que moyennés avec des périodes de repos.
					noteUiProbePreviewFrame();
				})
				.catch((cause: unknown) => {
					console.warn("[compositor-view] readFrame failed:", cause);
					// Native reports the render thread's fatal error here (see the addon's
					// `read_frame`), and it is the ONLY place it can surface: `createView`
					// has long since returned an id by the time the thread dies. Stop
					// polling — a dead thread never publishes another frame — and hand the
					// message up so the user gets it instead of a silent black canvas.
					if (disposed) {
						return;
					}
					cancelAnimationFrame(pullRafHandle);
					pullRafHandle = 0;
					window.clearTimeout(idleTimer);
					idleTimer = 0;
					setError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					inFlight = false;
				});
		};

		// Initial mount: allocate the native view with the rect observed at
		// the moment the effect ran. The async id will be used on subsequent
		// resize/scroll updates. Without the bridge, this is a swallowed
		// warning — the rest of the hook stays inert.
		const initialRect = computePreviewRect(
			canvas.getBoundingClientRect(),
			usePreviewPreferences.getState().quality,
			window.devicePixelRatio,
		);
		lastRect = initialRect;
		// Prime the canvas drawing buffer to the resolution we expect the
		// first pulled frame to have; avoids a 300x150 flash before the
		// first readFrame resolves.
		syncCanvasSize(initialRect);

		safelyCall("createView", async () => {
			const result = await createCompositorView(initialRect, opts.sources);
			if (disposed) {
				// The element unmounted before the response came back; clean up.
				safelyCall("destroyView (late)", () => destroyCompositorView(result.id));
				return;
			}
			viewIdRef.current = result.id;
			nativeViewId = result.id;
			setViewId(result.id);
			// A resize or quality change may have happened while creation was in flight.
			lastRect = null;
			applyRectNow();
		});

		const unsubscribeQuality = usePreviewPreferences.subscribe((next, previous) => {
			if (next.quality !== previous.quality) scheduleRectUpdate();
		});
		let densityQuery: MediaQueryList | undefined;
		const watchDensity = () => {
			densityQuery?.removeEventListener("change", onDensityChange);
			densityQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
			densityQuery?.addEventListener("change", onDensityChange);
		};
		const onDensityChange = () => {
			watchDensity();
			scheduleRectUpdate();
		};
		watchDensity();
		const observer = new ResizeObserver(scheduleRectUpdate);
		observer.observe(canvas);
		window.addEventListener("resize", scheduleRectUpdate);
		// capture phase so we observe parent scroll containers too,
		// not just `window` — the preview pane may scroll independently.
		window.addEventListener("scroll", scheduleRectUpdate, true);

		// Start the pull loop only after the view id is published — otherwise
		// every early tick would just hit `id == null` and no-op. Id is set
		// in the safelyCall above; we also pull here defensively for the
		// common case (addon absent → synthetic negative id, pull returns null,
		// no draw happens). The pull loop self-cancels in cleanup.
		pullRafHandle = requestAnimationFrame(pullLoop);

		return () => {
			disposed = true;
			unsubscribeCommands();
			if (rectRafHandle !== 0) {
				cancelAnimationFrame(rectRafHandle);
			}
			if (pullRafHandle !== 0) {
				cancelAnimationFrame(pullRafHandle);
			}
			window.clearTimeout(idleTimer);
			observer.disconnect();
			unsubscribeQuality();
			densityQuery?.removeEventListener("change", onDensityChange);
			longTaskObserver?.disconnect();
			window.clearInterval(timingFlushHandle);
			window.removeEventListener("resize", scheduleRectUpdate);
			window.removeEventListener("scroll", scheduleRectUpdate, true);
			const id = viewIdRef.current;
			if (id != null) {
				safelyCall("destroyView", async () => {
					await flushTiming(id);
					await destroyCompositorView(id);
				});
			}
		};
		// `canvasRef` is a stable RefObject; we re-run (destroy + re-create the view) when the
		// enabled flag flips or the screen source changes.
	}, [active, canvasRef, screenPath]);

	const setParam = useCallback((key: string, value: CompositorParamValue) => {
		const id = viewIdRef.current;
		if (id == null) {
			return;
		}
		safelyCall("setParam", () => setCompositorParam(id, key, value));
	}, []);

	const setPlaying = useCallback((playing: boolean) => {
		const id = viewIdRef.current;
		if (id == null) {
			return;
		}
		safelyCall("setPlaying", () => setCompositorPlaying(id, playing));
	}, []);

	return { viewId, setParam, setPlaying, error };
}

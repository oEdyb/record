// Hosts the native D3D preview canvas (the sole pixel source) plus the
// interactive-only DOM hitboxes (screen framing, webcam drag), which review
// disables through `readOnly`. The shared source of truth is `useEditorSettings`,
// so toggling a slider here updates both the live preview (via the pushed
// scene) and the eventual native export.
//
// Architecture (matches the legacy `compositeLayout.computeCompositeLayout`,
// which this file still uses to POSITION the interactive overlays/hitboxes —
// the actual pixels come from the native canvas, not from this layout):
//   .previewFrame           → canvas (wallpaper bg; never receives padding
//                             from the slider directly).
//   .screenStage            → sizes/positions the screen-framing hitbox by
//                             the composite-layout math (PiP/dual/stack/no-cam);
//                             its own <video> is CSS-hidden (decode/clock only).
//   .webcamSlot             → drag-to-reposition hitbox for the webcam PiP,
//                             positioned by the same math; its <video> is
//                             CSS-hidden too.
//
// The composite layout is computed from `.previewFrame`'s actual rendered
// size (via ResizeObserver), so the camera + screen both resize correctly
// as the user resizes the workbench.

import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CameraFullscreenRegion,
	type CropRegion,
	DEFAULT_CROP_REGION,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
} from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import { resolveOutputAspectRatioValue } from "@/lib/ai-edition/document/outputFormat";
import type { AxcutClip, AxcutTrimRange, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { resolveActiveCameraTrack } from "@/lib/ai-edition/timeline/camera";
import { createPlaybackClockRef } from "@/lib/ai-edition/timeline/playback-clock";
import type { SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import {
	computeCameraEmphasisRect,
	computeCameraFullscreenRect,
	computeCompositeLayout,
	type WebcamCompositeLayout,
} from "@/lib/compositeLayout";
import {
	dragScreenFocalPoint,
	MAX_SCREEN_FRAMING_SCALE,
	MIN_SCREEN_FRAMING_SCALE,
	resolveScreenFraming,
	type ScreenFraming,
	screenFramingVariantKey,
	screenVisibleFractions,
	setScreenFramingForVariant,
} from "@/lib/screenFraming";
import { classifyWallpaper, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import { computeCameraLayoutState } from "@/lib/zoomMath/cameraFullscreenUtils";
import { clamp, clamp01 } from "@/utils/math";
import { AudioOverlayPlayback } from "./AudioOverlayPlayback";
import { NativeCompositorOverlay } from "./NativeCompositorOverlay";
import styles from "./ReviewSurface.module.css";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";
import { WebcamOverlay } from "./WebcamOverlay";

interface PreviewCanvasProps {
	videoSources: VideoSource[];
	clips: AxcutClip[];
	zoomRegions?: AxcutZoomRegion[];
	speedRegions?: SpeedRegion[];
	cameraFullscreenRegions?: CameraFullscreenRegion[];
	trimRanges?: AxcutTrimRange[];
	seekTarget: { timeSec: number; requestId: number } | null;
	onTimeChange: (sec: number) => void;
	onSeek: (sec: number) => void;
	onLoadedMetadata: (sec: number, assetId: string) => void;
	onVideoElement: (el: HTMLVideoElement | null) => void;
	currentTimeSec: number;
	/** Receives the id of the asset whose <video> failed — the caller decides per
	 *  source whether anything is left to render (see Preview.tsx). */
	onVideoError?: (assetId: string) => void;
	/** Enables direct screen framing while the Layout inspector is visible. */
	screenFramingEnabled?: boolean;
	readOnly?: boolean;
}

// ponytail: fallback only — used until the active source's <video> reports
// its real intrinsic size via onLoadedMetadata. Nothing in the import/record
// pipeline ever probes/stores a recording's actual resolution (AxcutAsset's
// `video.width/height` is never populated), so without this the composite
// layout always assumed 16:9 regardless of the real capture — a recording at
// any other aspect then letterboxed a SECOND time inside its own screenRect
// (the <video> contain-fits its true ratio within a box sized for the wrong
// one), on top of the intentional `settings.padding` margin.
const SCREEN_SOURCE_SIZE = { width: 1920, height: 1080 };
// ponytail: live preview defaults until the camera <video> reports its real
// dimensions via loadedmetadata. 4:3 is the legacy default — typical webcams
// capture at 1.33, and using a 16:9 default collapses vertical-stack to a
// degenerate full-bleed camera with 0px screen height.
const WEBCAM_SOURCE_SIZE = { width: 960, height: 720 };

export function PreviewCanvas(props: PreviewCanvasProps) {
	const screenFramingEnabled = !props.readOnly && props.screenFramingEnabled;
	const te = useScopedT("editor");
	const ts = useScopedT("settings");
	const { settings, setLive, commit } = useEditorSettings();
	// Captions are derived from the transcript, not passed down as regions — the
	// preview reads them from the same façade the inspector writes to.
	const document = useProjectStore((s) => s.document);
	const assets = document?.assets ?? [];
	const frameRef = useRef<HTMLDivElement | null>(null);
	const webcamSlotRef = useRef<HTMLDivElement | null>(null);
	const screenSlotRef = useRef<HTMLDivElement | null>(null);
	const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// One clock per mounted canvas, shared between the screen preview (writer)
	// and the webcam overlay (reader) — see playback-clock.ts.
	const clockRefHolder = useRef<ReturnType<typeof createPlaybackClockRef>>();
	if (!clockRefHolder.current) clockRefHolder.current = createPlaybackClockRef();
	const clockRef = clockRefHolder.current;
	// Real dimensions of the active source, from the <video>'s own
	// onLoadedMetadata (videoWidth/videoHeight) — null until the first source
	// loads, then falls back to SCREEN_SOURCE_SIZE.
	const [screenNativeSize, setScreenNativeSize] = useState<{
		width: number;
		height: number;
	} | null>(null);
	// ponytail: contain-fit the frame within its wrapper ourselves. CSS
	// `aspect-ratio` + `width: 100%` + `max-height: 100%` only clamps height —
	// it never shrinks width back down to match, so portrait ratios (9:16 etc)
	// silently overflowed/stretched instead of fitting. Measuring the parent
	// (not the frame, which we're about to size) lets us compute an explicit
	// pixel box that actually respects the ratio on both axes.
	const [containerSize, setContainerSize] = useState({ width: 1280, height: 720 });
	// ponytail: StrictMode's dev-only mount→cleanup→remount double-invoke
	// creates a fresh ResizeObserver, disconnects it, then creates ANOTHER
	// fresh one observing the same element in the same tick. Chromium
	// silently drops all FUTURE notifications for that element when this
	// exact disconnect-then-immediately-recreate pattern happens (confirmed
	// live: a raw counter in the callback never incremented past the initial
	// synchronous calls, even across a real viewport resize) — the frame
	// would freeze at its first-paint size and never resize again. Holding
	// the observer instance in a ref (surviving the double-invoke, since
	// only the effect body reruns) and just toggling observe/unobserve on it
	// avoids ever recreating the instance, which sidesteps the bug.
	const containerObserverRef = useRef<ResizeObserver | null>(null);

	useEffect(() => {
		const el = frameRef.current?.parentElement;
		if (!el) return;
		// ponytail: measure the parent's content box, not its border box —
		// clientWidth/clientHeight include any padding, and sizing the frame to
		// the full padded box while it's centered in the smaller content area
		// pushed it past the padding edge, where overflow:hidden clipped the
		// video. The parent (.previewWrap) is currently zero-padding, but
		// subtracting computed padding keeps this correct if that ever changes.
		const update = () => {
			const cs = getComputedStyle(el);
			const paddingX = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight);
			const paddingY = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
			setContainerSize({
				width: (el.clientWidth || 1280) - (Number.isFinite(paddingX) ? paddingX : 0),
				height: (el.clientHeight || 720) - (Number.isFinite(paddingY) ? paddingY : 0),
			});
		};
		update();
		if (typeof ResizeObserver === "undefined") return;
		if (!containerObserverRef.current) {
			containerObserverRef.current = new ResizeObserver(update);
		}
		const observer = containerObserverRef.current;
		observer.observe(el);
		return () => observer.unobserve(el);
	}, []);

	// ponytail: `canvasSize` used to be a SEPARATE DOM measurement of `frameRef` (its own
	// ResizeObserver, watching the frame element after it's sized). That was a second source
	// of truth for the exact same number `frameSize` below already computes synchronously from
	// `containerSize` + the aspect ratio -- and being observer-driven, it could go stale
	// relative to `frameSize` (this file's own comment above documents a known Chromium
	// ResizeObserver double-observe/freeze failure mode; a remount of the frame element would
	// leave this second observer watching a detached node forever). That staleness meant the
	// webcam-position math below (which needs to agree with the frame's ACTUAL rendered size)
	// could clamp against a WRONG canvas size after switching aspect ratio -- manifesting as
	// "can't drag the webcam flush to the edge" at non-default ratios. `frameSize` is already
	// exactly what the frame is styled to (`width: frameSize.width` a few lines below), so it's
	// used directly everywhere `canvasSize` used to be — one source of truth, no separate
	// observer that can desync from it.
	// `resolveAspectRatioValue`, not bare `getAspectRatioValue`: the latter has no document to
	// resolve the legacy "native" selection against and answers 16/9 for it, so a project saved
	// with "native" over portrait footage framed the preview 16:9 while `pickOutputDims` handed
	// the compositor a portrait `output` — preview and export disagreed on the frame's shape.
	const frameSize = useMemo(() => {
		const ratio = resolveOutputAspectRatioValue(
			document,
			settings.aspectRatio,
			settings.outputResolution,
		);
		const { width: containerWidth, height: containerHeight } = containerSize;
		if (containerWidth <= 0 || containerHeight <= 0)
			return { width: containerWidth, height: containerHeight };
		if (containerWidth / containerHeight > ratio) {
			const height = containerHeight;
			return { width: Math.round(height * ratio), height: Math.round(height) };
		}
		const width = containerWidth;
		return { width: Math.round(width), height: Math.round(width / ratio) };
	}, [containerSize, settings.aspectRatio, settings.outputResolution, document]);

	// Crop is per-clip (see clipSchema.cropRegion) — resolve it from whichever
	// clip the playhead is currently inside, the same lookup VirtualPreview
	// itself uses to map playback position back to a clip. `undefined` (no
	// crop stored) normalises to the identity region.
	const activeClip = useMemo(
		() => locateVirtualPosition(props.clips, props.currentTimeSec)?.clip ?? null,
		[props.clips, props.currentTimeSec],
	);
	const cropRegion: CropRegion = activeClip?.cropRegion ?? DEFAULT_CROP_REGION;

	// P4 — the layout preset is global (one panel for the whole timeline) but the camera
	// is per clip, so the layout has to be resolved against the clip under the playhead.
	const activeCameraTrack = useMemo(
		() => resolveActiveCameraTrack(assets, props.clips, props.currentTimeSec),
		[assets, props.clips, props.currentTimeSec],
	);
	const activeClipHasCamera = Boolean(activeCameraTrack?.visible && activeCameraTrack.sourcePath);

	const layout = useMemo(() => {
		// A clip with no camera lays out as "no-webcam", whatever the panel says. Hiding
		// only the webcam slot is not enough: the block presets size the SCREEN off the
		// block, so the screen stayed squeezed into its half with nothing beside it.
		const preset = (
			activeClipHasCamera ? settings.webcamLayoutPreset : "no-webcam"
		) as WebcamLayoutPreset;
		const mask = settings.webcamMaskShape as WebcamMaskShape;
		// Padding shrinks the available content area for all layouts. The stacked
		// split then divides that complete area by the saved camera-share value.
		const paddingFit = clamp(1 - (clamp(settings.padding, 0, 100) / 100) * 0.4, 0.4, 1);
		const maxContentSize = {
			width: Math.round(frameSize.width * paddingFit),
			height: Math.round(frameSize.height * paddingFit),
		};
		// The screen box must be fit to the CROPPED aspect ratio, not the full
		// source frame's — otherwise VirtualPreview's crop math (which assumes
		// its container is already correctly proportioned for the crop) would
		// stretch the video to fill a mis-shaped box.
		const fullScreenSize = screenNativeSize ?? SCREEN_SOURCE_SIZE;
		const croppedScreenSize = {
			width: Math.max(1, Math.round(fullScreenSize.width * cropRegion.width)),
			height: Math.max(1, Math.round(fullScreenSize.height * cropRegion.height)),
		};
		return computeCompositeLayout({
			canvasSize: frameSize,
			maxContentSize,
			screenSize: croppedScreenSize,
			webcamSize: preset === "no-webcam" ? null : WEBCAM_SOURCE_SIZE,
			layoutPreset: preset,
			webcamSizePreset: settings.webcamSizePreset,
			// ponytail: PiP webcam is grabbable. Pass through the user's
			// position so the layout math places it at the dragged spot, not
			// the legacy default. Dual-frame / vertical-stack / no-webcam ignore
			// it (their preset definitions hardcode their own placement).
			webcamPosition: preset === "picture-in-picture" ? settings.webcamPosition : null,
			webcamMaskShape: mask,
			webcamCornerRadius: settings.webcamCornerRadius,
			webcamAspectRatio: settings.webcamAspectRatio,
			webcamBlockOrder: settings.webcamBlockOrder,
			webcamBlockCameraShare: settings.webcamBlockCameraShare,
		});
	}, [
		frameSize,
		screenNativeSize,
		cropRegion,
		activeClipHasCamera,
		settings.webcamLayoutPreset,
		settings.webcamBlockOrder,
		settings.webcamBlockCameraShare,
		settings.webcamMaskShape,
		settings.webcamCornerRadius,
		settings.webcamAspectRatio,
		settings.webcamSizePreset,
		settings.webcamPosition,
		settings.padding,
	]);
	const screenFramingKey = screenFramingVariantKey(settings.aspectRatio, settings.outputResolution);
	const screenFraming = resolveScreenFraming(settings.screenFramingByVariant, screenFramingKey);
	const updateScreenFramingLive = useCallback(
		(next: ScreenFraming) => {
			const currentDocument = useProjectStore.getState().document;
			const currentSettings = currentDocument ? getEditorSettings(currentDocument) : settings;
			setLive({
				screenFramingByVariant: setScreenFramingForVariant(
					currentSettings.screenFramingByVariant,
					screenFramingKey,
					next,
				),
			});
		},
		[screenFramingKey, setLive, settings],
	);

	// Full Camera: during a cameraFullscreen region the webcam takes the whole
	// frame and eases back. Same `computeCameraFullscreenRect` call as both
	// exporters and the native compositor, so all four animate identically.
	const cameraLayoutState = useMemo(
		() =>
			computeCameraLayoutState(
				props.cameraFullscreenRegions ?? [],
				Math.round(props.currentTimeSec * 1000),
			),
		[props.cameraFullscreenRegions, props.currentTimeSec],
	);
	const effectiveLayout = useMemo<WebcamCompositeLayout | null>(() => {
		if (!layout?.webcamRect || cameraLayoutState.progress <= 0) return layout;
		const webcamRect =
			cameraLayoutState.mode === "emphasis"
				? computeCameraEmphasisRect(
						layout.webcamRect,
						frameSize,
						cameraLayoutState.progress,
						cameraLayoutState.cameraScale,
					)
				: computeCameraFullscreenRect(layout.webcamRect, frameSize, cameraLayoutState.progress);
		const k = cameraLayoutState.driftScale;
		const drifted =
			k === 1
				? webcamRect
				: {
						...webcamRect,
						x: webcamRect.x + (webcamRect.width * (1 - k)) / 2,
						y: webcamRect.y + (webcamRect.height * (1 - k)) / 2,
						width: webcamRect.width * k,
						height: webcamRect.height * k,
					};
		return {
			...layout,
			webcamRect: drifted,
		};
	}, [layout, cameraLayoutState, frameSize]);

	const frameStyle = useMemo(() => buildFrameStyle(settings), [settings]);
	const screenStyle = useMemo(
		() => buildScreenStyle(layout, settings, frameSize),
		[layout, settings, frameSize],
	);
	const webcamStyle = useMemo(
		() => buildWebcamStyle(effectiveLayout, settings, frameSize),
		[effectiveLayout, settings, frameSize],
	);
	// `layout` already resolves to "no-webcam" (hence `webcamRect: null`) for a
	// camera-less clip, so this is belt-and-braces rather than the only guard.
	const showWebcamSlot = Boolean(layout?.webcamRect && activeClipHasCamera);
	const [isPlaying, setIsPlaying] = useState(false);
	const [isScreenDragging, setIsScreenDragging] = useState(false);
	const handleVideoElement = useMemo(() => props.onVideoElement, [props.onVideoElement]);
	// L'élément `<video>` lui-même n'est plus retenu : il ne servait qu'à échantillonner des pixels
	// pour la mosaïque dessinée en DOM, que le compositeur natif rend désormais.
	const relayIsPlaying = useCallback(
		(el: HTMLVideoElement | null) => {
			handleVideoElement(el);
			setIsPlaying(!el?.paused);
		},
		[handleVideoElement],
	);
	const relayLoadedMetadata = (
		durationSec: number,
		assetId: string,
		videoWidth: number,
		videoHeight: number,
	) => {
		if (videoWidth > 0 && videoHeight > 0) {
			setScreenNativeSize((prev) =>
				prev?.width === videoWidth && prev?.height === videoHeight
					? prev
					: { width: videoWidth, height: videoHeight },
			);
		}
		props.onLoadedMetadata(durationSec, assetId);
	};
	const relayProps = {
		...props,
		onVideoElement: relayIsPlaying,
		onLoadedMetadata: relayLoadedMetadata,
		cropRegion,
		clockRef,
	};

	const handleWebcamPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (props.readOnly) return;
		if (settings.webcamLayoutPreset !== "picture-in-picture") return;
		if (isPlaying) return;
		const slot = webcamSlotRef.current;
		if (!slot) return;
		const slotRect = slot.getBoundingClientRect();
		const frameRect = frameRef.current?.getBoundingClientRect();
		if (!frameRect) return;
		event.preventDefault();
		event.stopPropagation();
		const offsetX = event.clientX - (slotRect.left + slotRect.width / 2);
		const offsetY = event.clientY - (slotRect.top + slotRect.height / 2);
		slot.setPointerCapture(event.pointerId);

		const handleMove = (e: PointerEvent) => {
			const frameNow = frameRef.current?.getBoundingClientRect();
			if (!frameNow) return;
			const cx = clamp01((e.clientX - offsetX - frameNow.left) / frameNow.width);
			const cy = clamp01((e.clientY - offsetY - frameNow.top) / frameNow.height);
			setLive({ webcamPosition: { cx, cy } });
		};
		const handleUp = () => {
			slot.removeEventListener("pointermove", handleMove);
			slot.removeEventListener("pointerup", handleUp);
			slot.removeEventListener("pointercancel", handleUp);
			try {
				slot.releasePointerCapture(event.pointerId);
			} catch {
				// pointer already released
			}
			void commit();
		};
		slot.addEventListener("pointermove", handleMove);
		slot.addEventListener("pointerup", handleUp);
		slot.addEventListener("pointercancel", handleUp);
	};

	const handleScreenPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!screenFramingEnabled || isPlaying || !layout?.screenRect) return;
		const slot = screenSlotRef.current;
		if (!slot) return;
		const slotRect = slot.getBoundingClientRect();
		const source = screenNativeSize ?? SCREEN_SOURCE_SIZE;
		const start = screenFraming;
		const visible = screenVisibleFractions({
			sourceWidth: source.width * cropRegion.width,
			sourceHeight: source.height * cropRegion.height,
			boxWidth: layout.screenRect.width,
			boxHeight: layout.screenRect.height,
			cover: layout.screenCover ?? false,
			scale: start.scale,
		});
		event.preventDefault();
		event.stopPropagation();
		slot.setPointerCapture(event.pointerId);
		setIsScreenDragging(true);
		const startX = event.clientX;
		const startY = event.clientY;

		const handleMove = (nextEvent: PointerEvent) => {
			updateScreenFramingLive({
				...start,
				focalPoint: dragScreenFocalPoint({
					start: start.focalPoint,
					deltaX: nextEvent.clientX - startX,
					deltaY: nextEvent.clientY - startY,
					boxWidth: slotRect.width,
					boxHeight: slotRect.height,
					visible,
				}),
			});
		};
		const handleUp = () => {
			slot.removeEventListener("pointermove", handleMove);
			slot.removeEventListener("pointerup", handleUp);
			slot.removeEventListener("pointercancel", handleUp);
			try {
				slot.releasePointerCapture(event.pointerId);
			} catch {
				// The browser can release capture before pointercancel arrives.
			}
			setIsScreenDragging(false);
			void commit();
		};
		slot.addEventListener("pointermove", handleMove);
		slot.addEventListener("pointerup", handleUp);
		slot.addEventListener("pointercancel", handleUp);
	};

	const handleScreenWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
		if (!screenFramingEnabled || isPlaying) return;
		event.preventDefault();
		event.stopPropagation();
		const scale = clamp(
			screenFraming.scale * Math.exp(-event.deltaY * 0.002),
			MIN_SCREEN_FRAMING_SCALE,
			MAX_SCREEN_FRAMING_SCALE,
		);
		updateScreenFramingLive({ ...screenFraming, scale });
		if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
		wheelCommitTimerRef.current = setTimeout(() => {
			wheelCommitTimerRef.current = null;
			void commit();
		}, 180);
	};

	useEffect(
		() => () => {
			if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
		},
		[],
	);

	const isPipGrab = !props.readOnly && settings.webcamLayoutPreset === "picture-in-picture";

	return (
		<div
			ref={frameRef}
			className={styles.previewFrame}
			style={{ ...frameStyle, width: frameSize.width, height: frameSize.height }}
		>
			{/* Sole pixel source: the D3D-composited frame (wallpaper + screen + webcam +
			    cursor), streamed into a canvas. The <video> elements below are CSS-hidden
			    (visibility only — they stay mounted for decode/playback-clock/metadata
			    duties, since the native compositor doesn't drive playback itself). Zooms and
			    annotations are drawn by the native compositor; the screen-framing and webcam
			    drag hitboxes render on top as normal DOM. No more dual preview path. */}
			<NativeCompositorOverlay />
			<AudioOverlayPlayback clockRef={clockRef} />
			{layout?.screenRect ? (
				<div
					ref={screenSlotRef}
					className={styles.screenStage}
					style={{
						...screenStyle,
						cursor:
							screenFramingEnabled && !isPlaying
								? isScreenDragging
									? "grabbing"
									: "grab"
								: "default",
						touchAction: screenFramingEnabled ? "none" : "auto",
					}}
					tabIndex={screenFramingEnabled && !isPlaying ? 0 : -1}
					aria-label={screenFramingEnabled ? ts("layout.screenFramingPreview") : undefined}
					onPointerDown={handleScreenPointerDown}
					onWheel={handleScreenWheel}
					onKeyDown={(event) => {
						if (!screenFramingEnabled || isPlaying) return;
						const point = screenFraming.focalPoint;
						const step = event.shiftKey ? 0.1 : 0.02;
						let next: ScreenFraming | null = null;
						if (event.key === "ArrowLeft")
							next = { ...screenFraming, focalPoint: { ...point, cx: clamp01(point.cx - step) } };
						else if (event.key === "ArrowRight")
							next = { ...screenFraming, focalPoint: { ...point, cx: clamp01(point.cx + step) } };
						else if (event.key === "ArrowUp")
							next = { ...screenFraming, focalPoint: { ...point, cy: clamp01(point.cy - step) } };
						else if (event.key === "ArrowDown")
							next = { ...screenFraming, focalPoint: { ...point, cy: clamp01(point.cy + step) } };
						else if (event.key === "+" || event.key === "=")
							next = {
								...screenFraming,
								scale: clamp(
									screenFraming.scale + 0.05,
									MIN_SCREEN_FRAMING_SCALE,
									MAX_SCREEN_FRAMING_SCALE,
								),
							};
						else if (event.key === "-" || event.key === "_")
							next = {
								...screenFraming,
								scale: clamp(
									screenFraming.scale - 0.05,
									MIN_SCREEN_FRAMING_SCALE,
									MAX_SCREEN_FRAMING_SCALE,
								),
							};
						else if (event.key === "Home" || event.key === "0")
							next = { scale: 1, focalPoint: { cx: 0.5, cy: 0.5 } };
						if (!next) return;
						event.preventDefault();
						updateScreenFramingLive(next);
					}}
					onKeyUp={(event) => {
						if (
							[
								"ArrowLeft",
								"ArrowRight",
								"ArrowUp",
								"ArrowDown",
								"+",
								"=",
								"-",
								"_",
								"Home",
								"0",
							].includes(event.key)
						) {
							void commit();
						}
					}}
				>
					{(() => {
						// ponytail: PreviewCompositor (Pixi v8) regressed the screen
						// preview — the `<video>` is `visibility: hidden` while it's
						// the decode source for a Pixi VideoSource, and the
						// combination of `setPixiReady` + `canvasSize === {0,0}` on
						// mount produces a 1x1 canvas that the resize effect never
						// widens (the user reports either an empty stage showing
						// the wallpaper through, or a black rectangle where the
						// screen recording should be). Falling back to the legacy
						// VirtualPreview path — CSS-transformed <video> + measure
						// on ResizeObserver — until the Pixi path is hardened
						// behind a flag with its own tests.
						// See technical-documentation/architecture/preview.md
						// (todo) for the failure write-up.
						void relayProps.clockRef;
						return (
							<VirtualPreview
								{...relayProps}
								videoStyle={videoBorderRadiusStyle(layout, settings)}
							/>
						);
					})()}
				</div>
			) : null}
			{layout?.webcamRect && showWebcamSlot ? (
				<div
					ref={webcamSlotRef}
					className={styles.webcamSlot}
					style={{
						...webcamStyle,
						cursor: isPipGrab && !isPlaying ? "grab" : "default",
						touchAction: "none",
					}}
					onPointerDown={isPipGrab ? handleWebcamPointerDown : undefined}
					aria-label={te("preview.webcamPreview")}
				>
					<WebcamOverlay
						clips={props.clips}
						currentTimeSec={props.currentTimeSec}
						onTimeChange={props.onTimeChange}
						isPlaying={isPlaying}
						clockRef={clockRef}
						borderRadius={
							effectiveLayout?.webcamRect?.borderRadius ?? layout.webcamRect.borderRadius
						}
						webcamMaskShape={effectiveLayout?.webcamRect?.maskShape ?? settings.webcamMaskShape}
						layoutPreset={settings.webcamLayoutPreset}
					/>
				</div>
			) : null}
		</div>
	);
}

// ponytail: resolve `settings.wallpaper` to an actual CSS background. Image
// wallpapers must go through resolveImageWallpaperUrl (→ getAssetPath): in the
// packaged Electron app the renderer loads over file://, where a bare
// `/wallpapers/foo.jpg` points at the filesystem root and 404s, so the custom
// background silently failed to paint (worked in the http dev server only).
// classifyWallpaper also handles color-function (rgb/hsl/…) and every gradient
// variant, which the old ad-hoc startsWith checks missed.
function resolveWallpaperImageUrl(imagePath: string): string | null {
	try {
		return resolveImageWallpaperUrl(imagePath);
	} catch {
		return null;
	}
}

// Canvas: wallpaper only — no padding, no shadow.
function buildFrameStyle(
	settings: ReturnType<typeof useEditorSettings>["settings"],
): React.CSSProperties {
	const w = classifyWallpaper(settings.wallpaper);
	if (w.kind === "color") return { backgroundColor: w.value };
	if (w.kind === "gradient") return { backgroundImage: w.value, backgroundSize: "cover" };
	const url = resolveWallpaperImageUrl(w.path);
	if (!url) return {};
	return {
		backgroundImage: `url(${url})`,
		backgroundSize: "cover",
		backgroundPosition: "center",
		backgroundRepeat: "no-repeat",
	};
}

// Screen stage: rectangle from the composite layout, converted to percentages
// of the canvas. Positions/sizes the screen-framing hitbox and the CSS-hidden
// <video> (decode/clock only) — no borderRadius/boxShadow here: the native canvas already draws its
// own rounded corners + shadow for this exact rect, and this container sits
// on TOP of it (z-index for the interactive layers). Duplicating the same
// decoration in CSS produced a visible "double rounded corner" — two
// slightly-offset rounded edges (native's + this container's own) instead of
// one.
function buildScreenStyle(
	layout: WebcamCompositeLayout | null,
	_settings: ReturnType<typeof useEditorSettings>["settings"],
	canvasSize: { width: number; height: number },
): React.CSSProperties {
	if (!layout?.screenRect) return { display: "none" };
	const r = layout.screenRect;
	return {
		position: "absolute",
		left: `${(r.x / canvasSize.width) * 100}%`,
		top: `${(r.y / canvasSize.height) * 100}%`,
		width: `${(r.width / canvasSize.width) * 100}%`,
		height: `${(r.height / canvasSize.height) * 100}%`,
		overflow: "hidden",
		display: "flex",
	};
}

function videoBorderRadiusStyle(
	layout: WebcamCompositeLayout | null,
	settings: ReturnType<typeof useEditorSettings>["settings"],
): React.CSSProperties {
	const borderRadius = layout?.screenBorderRadius ?? settings.borderRadius;
	return { borderRadius: `${borderRadius}px` };
}

// Webcam slot: full composite-layout rect — sizes/positions the drag hitbox
// (handleWebcamPointerDown) and the CSS-hidden webcam <video> (decode/clock
// only). No borderRadius/boxShadow: the native canvas already draws its own
// rounded/circular shape + shadow for this exact rect (duplicating it here
// produced a visible "double rounded corner"). `clipPath` is kept — unlike
// borderRadius/boxShadow it's not just decoration, it also shapes the
// hitbox's actual pointer-event area (e.g. "circle" mask), which should still
// match the native-drawn shape.
function buildWebcamStyle(
	layout: WebcamCompositeLayout | null,
	settings: ReturnType<typeof useEditorSettings>["settings"],
	canvasSize: { width: number; height: number },
): React.CSSProperties {
	if (!layout?.webcamRect) return { display: "none" };
	const r = layout.webcamRect;
	// The RECT's own shape, not the setting: Full Camera flattens the mask to a
	// rectangle as it takes the frame, and the hitbox must follow (a circular
	// clip-path over a full-screen camera would swallow clicks everywhere but a
	// disc in the middle).
	const mask = r.maskShape ?? (settings.webcamMaskShape as WebcamMaskShape);
	const clipPath = getCssClipPath(mask);
	const base: React.CSSProperties = {
		position: "absolute",
		left: `${(r.x / canvasSize.width) * 100}%`,
		top: `${(r.y / canvasSize.height) * 100}%`,
		width: `${(r.width / canvasSize.width) * 100}%`,
		height: `${(r.height / canvasSize.height) * 100}%`,
		overflow: "hidden",
		display: "flex",
		background: "transparent",
	};
	return clipPath ? { ...base, clipPath } : base;
}

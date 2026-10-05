import { Clapperboard, NotepadText, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { getAvailableLocales, getLocaleName } from "@/i18n/loader";
import { requireEntitlement } from "@/lib/entitlements/store";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { nativeBridgeClient } from "@/native";
import { formatTimePadded } from "@/utils/timeUtils";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import { type CameraDevice, useCameraDevices } from "../../hooks/useCameraDevices";
import { useCameraPreviewFrameBridge } from "../../hooks/useCameraPreviewFrameBridge";
import { type MicrophoneDevice, useMicrophoneDevices } from "../../hooks/useMicrophoneDevices";
import { usePortalOwnsSource } from "../../hooks/usePortalOwnsSource";
import { useScreenRecorder } from "../../hooks/useScreenRecorder";
import type { RecordingQuality } from "../../lib/recording/recordingQuality";
import { requestCameraAccess } from "../../lib/requestCameraAccess";
import type { WebcamFormat } from "../../lib/webcamFormats";
import { Toaster } from "../ui/sonner";
import { ensureDefaultRecordingSource } from "./defaultRecordingSource";
import { HudClipPeek, type HudClipPeekLabels } from "./HudClipPeek";
import {
	HudBrandMark,
	HudCameraButton,
	HudCompactPauseButton,
	HudCompactRecordButton,
	HudCompactTimer,
	HudDragHandle,
	HudExpandButton,
	HudMicButton,
	HudNotice,
	HudRemovePreviousClipButton,
	HudSettingsButton,
	HudSourceChip,
	HudStopButton,
	HudSystemAudioButton,
} from "./HudControls";
import {
	HudDeviceSettings,
	type HudDeviceSettingsLabels,
	type HudSetupExtras,
} from "./HudDeviceSettings";
import {
	computeHudBarMaxHeight,
	computeHudModalMaxHeight,
	computeHudPopoverMaxHeight,
	computeHudWindowSize,
	HUD_BAR_BOTTOM,
	HUD_GROWTH_RESERVE,
	HUD_POPOVER_GAP,
	HUD_STACK_GAP,
} from "./hudGeometry";
import styles from "./LaunchWindow.module.css";
import { openSourceSelectorWithPermissionRetry } from "./openSourceSelectorFlow";
import {
	prefetchPickerSources,
	SourcePicker,
	type SourcePickerKind,
	warmPickerSources,
} from "./SourceSelector";
import { usePresence } from "./usePresence";
import { useRecordingHudPresentation } from "./useRecordingHudPresentation";

// Locale list is computed once at module load; keeping the reference stable lets
// the setup panel sit behind a memo boundary.
const AVAILABLE_LOCALES = getAvailableLocales();

// Used only when the renderer can't see a real display (tests, headless).
const FALLBACK_SCREEN_HEIGHT = 1080;
const FALLBACK_SCREEN_WIDTH = 1920;
const HUD_PILL_WIDTH = 424;
const HUD_PILL_HEIGHT = 50;
/** Toasts sit just above the pill: its bottom gap, its height and one stack gap. */
const HUD_TOAST_OFFSET = HUD_BAR_BOTTOM + HUD_PILL_HEIGHT + HUD_STACK_GAP;
const REMOVED_CLIP_FEEDBACK_MS = 4_000;

function formatClipDuration(durationMs: number): string {
	return formatTimePadded(Math.max(1, Math.round(durationMs / 1_000)));
}

/**
 * Work-area height of the display, which is what the HUD's vertical budget is
 * really bounded by. Deliberately NOT `window.innerHeight`: the overlay window's
 * own height is the value this measurement feeds back into, and reading it here
 * is exactly what used to close the resize feedback loop.
 */
function getAvailableScreenHeight(): number {
	const available = typeof window === "undefined" ? 0 : window.screen?.availHeight;
	return available && available > 0 ? available : FALLBACK_SCREEN_HEIGHT;
}

function getAvailableScreenWidth(): number {
	const available = typeof window === "undefined" ? 0 : window.screen?.availWidth;
	return available && available > 0 ? available : FALLBACK_SCREEN_WIDTH;
}

/** Launches the floating recording HUD and its recorder controls. */
export function LaunchWindow() {
	const t = useScopedT("launch");
	const commonT = useScopedT("common");
	const editorT = useScopedT("editor");
	const {
		locale,
		setLocale,
		systemLocaleSuggestion,
		acceptSystemLocaleSuggestion,
		dismissSystemLocaleSuggestion,
		resolveSystemLocaleSuggestion,
	} = useI18n();
	const suggestedLanguageName = systemLocaleSuggestion ? getLocaleName(systemLocaleSuggestion) : "";

	const {
		preferencesReady,
		starting,
		recording,
		paused,
		saving,
		clipFinalizing,
		elapsedSeconds,
		activeClipElapsedMs,
		recordedClips,
		toggleRecording,
		togglePaused,
		canPauseRecording,
		canReconfigureWhilePaused,
		canRemovePreviousClip,
		removePreviousClip,
		restoreRemovedClip,
		restartRecording,
		cancelRecording,
		microphoneEnabled,
		setMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId,
		setMicrophoneDeviceName,
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		webcamPreviewStream,
		setWebcamEnabled,
		webcamDeviceId,
		setWebcamDeviceId,
		setWebcamDeviceName,
		recordingQuality,
		setRecordingQuality,
		webcamFormat,
		setWebcamFormat,
		webcamFormatAuto,
		setWebcamFormatAuto,
		cursorCaptureMode,
		setCursorCaptureMode,
		softwareEncoderFallbackNoticeVisible,
		dismissSoftwareEncoderFallbackNotice,
	} = useScreenRecorder();
	useCameraPreviewFrameBridge(webcamPreviewStream);

	// Choosing a device and switching one on are deliberately separate concerns.
	// The mic and camera buttons are plain on/off toggles that use whatever device
	// is currently selected (the system default until the user says otherwise);
	// picking a different device — and checking it actually works — happens in the
	// settings panel. Overloading one button with both jobs is what made turning a
	// camera after two clicks.
	const [isDeviceSettingsOpen, setIsDeviceSettingsOpen] = useState(false);
	const [isSourcePanelOpen, setIsSourcePanelOpen] = useState(false);
	const [isPeekOpen, setIsPeekOpen] = useState(false);
	const [supportsCursorModeToggle, setSupportsCursorModeToggle] = useState(false);
	const [isLinuxHud, setIsLinuxHud] = useState(false);
	const [openedFromEditor, setOpenedFromEditor] = useState(false);
	const returnToReview =
		new URLSearchParams(window.location.search).get("returnToReview") === "true";
	const hasReviewReturn = openedFromEditor || returnToReview;
	const [removedClipFeedback, setRemovedClipFeedback] = useState<RecordingSessionClip | null>(null);
	const removedClipFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const removedClipFeedbackGenerationRef = useRef(0);
	const restoringRemovedClipRef = useRef(false);
	/**
	 * Narrower than [`isLinuxHud`] on purpose: without the helper the recorder
	 * falls back to Chromium's capture, which DOES take a source id, so the
	 * in-app picker has to stay for that case.
	 */
	const portalOwnsSource = usePortalOwnsSource();
	const presentation = useRecordingHudPresentation(recording, saving, {
		paused,
		elapsedSeconds,
		activeClipElapsedMs,
		recordedClips,
	});
	const recordingHudActive = presentation.active;
	// Switch to the recording pill the instant Record is pressed. The timer stays
	// at zero and Pause stays disabled until the writer confirms capture, so the
	// pill never claims a recording that has not started; Stop cancels the start.
	const pillRecording = recordingHudActive || starting;

	const keptClipCount = presentation.recordedClips.filter((clip) => !clip.removed).length;
	// The replay reads finished clip files, so it exists only while a completed
	// Pause has handed every kept clip to disk.
	const canPeek =
		recording && presentation.paused && !saving && !clipFinalizing && keptClipCount > 0;
	const peekOpen = isPeekOpen && canPeek;
	const isPopoverOpen = isDeviceSettingsOpen || peekOpen || isSourcePanelOpen;
	const setupPresence = usePresence(isDeviceSettingsOpen, 150);
	const sourcePresence = usePresence(isSourcePanelOpen, 150);
	const removedClipPresence = usePresence(removedClipFeedback !== null, 120);
	const lastRemovedClipRef = useRef(removedClipFeedback);
	if (removedClipFeedback) lastRemovedClipRef.current = removedClipFeedback;
	const shownRemovedClip = removedClipPresence.present ? lastRemovedClipRef.current : null;
	// Replay opened with the Up key appears without animation.
	const [peekInstant, setPeekInstant] = useState(false);
	// The same controls stay in the same places while recording. Active capture
	// locks them; a completed macOS Pause unlocks them so their staged values can
	// be applied atomically before the next clip starts.
	const controlsLocked =
		starting || saving || clipFinalizing || (recording && !canReconfigureWhilePaused);
	const controlsLockedRef = useRef(controlsLocked);
	controlsLockedRef.current = controlsLocked;

	useEffect(() => {
		if (!canPeek) setIsPeekOpen(false);
	}, [canPeek]);

	useEffect(() => {
		let cancelled = false;
		void window.electronAPI?.getRecordingWorkspaceContext?.().then((result) => {
			if (!cancelled) setOpenedFromEditor(Boolean(result.success && result.context));
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const hudAnchorRef = useRef<HTMLDivElement | null>(null);
	const hudBarRef = useRef<HTMLDivElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const hudNoticesRef = useRef<HTMLDivElement | null>(null);
	const lastDirectionExclusionSignatureRef = useRef("");
	const reportDirectionExclusionRectangles = useCallback(() => {
		const rectangles = [hudBarRef.current, popoverRef.current, hudNoticesRef.current]
			.filter((element): element is HTMLDivElement => Boolean(element?.isConnected))
			.map((element) => element.getBoundingClientRect())
			.filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
			.map((rectangle) => ({
				x: rectangle.x,
				y: rectangle.y,
				width: rectangle.width,
				height: rectangle.height,
			}));
		const signature = JSON.stringify(rectangles);
		if (signature === lastDirectionExclusionSignatureRef.current) return;
		lastDirectionExclusionSignatureRef.current = signature;
		window.electronAPI?.setHudDirectionExclusionRectangles?.(rectangles);
	}, []);

	// React-driven content changes can resize a popover without resizing the HUD
	// window. Report after every committed render; the signature guard prevents
	// repeated IPC for the once-per-second recording timer.
	useLayoutEffect(() => {
		reportDirectionExclusionRectangles();
	});

	// The camera list is enumerated from mount rather than on first open. It costs
	// one enumerateDevices() call and means the picker renders its final content
	// on its very first frame, and that `webcamDeviceId` is already the default
	// device when the button is clicked — so enabling the camera acquires the
	// right stream once instead of acquiring the default and then re-acquiring.
	const {
		devices: cameraDevices,
		selectedDeviceId: selectedCameraId,
		setSelectedDeviceId: setSelectedCameraId,
		isLoading: isCameraDevicesLoading,
		error: cameraDevicesError,
	} = useCameraDevices(true);
	// The microphone list stays lazy: enumerating it asks for mic permission,
	// which would light the OS "in use" indicator just for opening the HUD.
	const {
		devices: micDevices,
		selectedDeviceId: selectedMicId,
		setSelectedDeviceId: setSelectedMicId,
		isLoading: isMicDevicesLoading,
	} = useMicrophoneDevices(microphoneEnabled || isDeviceSettingsOpen);

	useEffect(() => {
		if (!preferencesReady || isMicDevicesLoading || !micDevices.length) return;
		if (microphoneDeviceId && micDevices.some((device) => device.deviceId === microphoneDeviceId)) {
			if (microphoneDeviceId !== selectedMicId) setSelectedMicId(microphoneDeviceId);
			setMicrophoneDeviceName(
				micDevices.find((device) => device.deviceId === microphoneDeviceId)?.label,
			);
			return;
		}
		if (selectedMicId && selectedMicId !== "default") {
			setMicrophoneDeviceId(selectedMicId);
			setMicrophoneDeviceName(micDevices.find((d) => d.deviceId === selectedMicId)?.label);
		}
	}, [
		preferencesReady,
		isMicDevicesLoading,
		microphoneDeviceId,
		selectedMicId,
		micDevices,
		setSelectedMicId,
		setMicrophoneDeviceId,
		setMicrophoneDeviceName,
	]);

	useEffect(() => {
		if (!preferencesReady || isCameraDevicesLoading || !cameraDevices.length) return;
		if (
			webcamDeviceId &&
			webcamDeviceId !== selectedCameraId &&
			cameraDevices.some((device) => device.deviceId === webcamDeviceId)
		) {
			setSelectedCameraId(webcamDeviceId);
			return;
		}
		if (selectedCameraId) {
			setWebcamDeviceId(selectedCameraId);
			setWebcamDeviceName(cameraDevices.find((d) => d.deviceId === selectedCameraId)?.label);
		}
	}, [
		preferencesReady,
		isCameraDevicesLoading,
		selectedCameraId,
		cameraDevices,
		setSelectedCameraId,
		setWebcamDeviceId,
		setWebcamDeviceName,
		webcamDeviceId,
	]);

	useEffect(() => {
		let cancelled = false;
		nativeBridgeClient.system
			.getPlatform()
			.then((platform) => {
				if (!cancelled) {
					// Every platform with a native capture helper that can honour the
					// choice, which is now all three. Windows passes `captureCursor`
					// to wgc-capture, macOS passes `hideSystemCursor` to the
					// ScreenCaptureKit helper, and Linux passes `cursorMode` to the
					// PipeWire helper, which asks the ScreenCast portal for METADATA
					// or EMBEDDED. All three genuinely omit the system cursor from
					// the pixels.
					//
					// Linux was excluded here until the helper existed, and the
					// reason is worth keeping: capture went through Chromium, and
					// Chromium offers NO way to suppress the cursor.
					// `DesktopCaptureDevice::Create` wraps every capturer in a
					// `DesktopAndCursorComposer` unconditionally; on Linux WebRTC
					// asks the portal for METADATA mode and then paints the cursor
					// back in itself. So the toggle would have switched the editor's
					// overlay on without changing the pixels — which is exactly how
					// you get two cursors. Verified against a real recording at the
					// time. The helper is what makes the control mean something,
					// because it owns the video and never asks WebRTC for anything.
					setSupportsCursorModeToggle(
						platform === "win32" || platform === "darwin" || platform === "linux",
					);
					setIsLinuxHud(platform === "linux");
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSupportsCursorModeToggle(false);
					setIsLinuxHud(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!import.meta.env.DEV) {
			return;
		}

		void requestCameraAccess().catch((error) => {
			console.warn("Failed to trigger camera access request during development:", error);
		});
	}, []);

	// One dismiss handler for both floating surfaces — they're mutually exclusive,
	// so a single pointerdown/Escape listener covers the pair instead of two.
	const closePopovers = useCallback(() => {
		setIsDeviceSettingsOpen(false);
		setIsPeekOpen(false);
		setIsSourcePanelOpen(false);
		recordAfterSourceSelectionRef.current = false;
	}, []);

	useEffect(() => {
		if (!isPopoverOpen) return;

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			const insideTrigger =
				target instanceof Element && target.closest("[data-hud-popover-trigger]") !== null;
			// A select inside the panel renders its option list in a portal on
			// document.body; clicking an option there is not a dismissal.
			const insideSelectPortal =
				target instanceof Element && target.closest("[data-klippt-select-content]") !== null;
			if (!insideTrigger && !insideSelectPortal && !popoverRef.current?.contains(target)) {
				closePopovers();
			}
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				closePopovers();
			}
		};

		window.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleEscape);

		return () => {
			window.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleEscape);
		};
	}, [closePopovers, isPopoverOpen]);

	// ---------------------------------------------------------------------------
	// Overlay window sizing
	//
	// The renderer owns the overlay window's size, so a naive "measure what's on
	// screen and grow to fit" is a feedback loop: the resize changes the viewport,
	// viewport-sized boxes re-layout, the observer fires again. That loop is what
	// made the HUD flicker and jump the first few times each popover was opened.
	//
	// Two rules break it, and both live here:
	//   1. Only the bar is measured. Everything floating above it has a fixed
	//      width and a capped height, so its space is *reserved* from the first
	//      frame — opening a popover costs zero native resizes.
	//   2. No measured box may be sized against the viewport. Caps come from
	//      screen.availHeight (which a window resize can't change) and are pushed
	//      down as CSS custom properties.
	// ---------------------------------------------------------------------------
	const hudAllocatedSizeRef = useRef({ width: 0, height: 0 });
	const isDraggingHudRef = useRef(false);

	const horizontalHudWidth = Math.min(HUD_PILL_WIDTH, getAvailableScreenWidth() - 32);

	useLayoutEffect(() => {
		const anchor = hudAnchorRef.current;
		if (!anchor) return;
		anchor.style.setProperty("--hud-bar-bottom", `${HUD_BAR_BOTTOM}px`);
		anchor.style.setProperty("--hud-popover-gap", `${HUD_POPOVER_GAP}px`);
		anchor.style.setProperty("--hud-stack-gap", `${HUD_STACK_GAP}px`);
		anchor.style.setProperty("--hud-horizontal-width", `${horizontalHudWidth}px`);
		anchor.style.setProperty(
			"--hud-bar-max-h",
			`${computeHudBarMaxHeight(getAvailableScreenHeight())}px`,
		);
	}, [horizontalHudWidth]);

	const measureHudSize = useCallback(() => {
		const barEl = hudBarRef.current;
		if (!barEl || !window.electronAPI?.setHudOverlaySize) return;
		reportDirectionExclusionRectangles();
		// While the user is dragging, a resize would re-anchor the window from its
		// own bounds and fight the position the drag is applying frame by frame.
		// Content is re-measured once the drag ends instead.
		if (isDraggingHudRef.current) return;

		const availableHeight = getAvailableScreenHeight();
		const barRect = barEl.getBoundingClientRect();
		const renderedBarHeight = barRect.height || barEl.scrollHeight;
		// Keep the native transparent backing window at the full horizontal HUD
		// allocation while the painted panel contracts. Resizing the BrowserWindow
		// on every animation frame makes the panel move and can briefly intercept
		// clicks outside the visible surface.
		const barWidth = horizontalHudWidth;
		const barHeight = Math.max(renderedBarHeight, HUD_PILL_HEIGHT);
		const noticeEl = hudNoticesRef.current;
		const noticeHeight = noticeEl
			? noticeEl.getBoundingClientRect().height || noticeEl.scrollHeight
			: 0;

		// The two floating surfaces get their own CSS caps (a 470px-tall language
		// list would look absurd), but the *window* always reserves room for the
		// taller of them. Sizing the reserve to whichever happens to be open would
		// mean the window grows when the panel opens — and since the stack is
		// bottom-anchored, growing upward moves every bit of content down in window
		// coordinates, which the renderer repaints a frame or two after the native
		// resize lands. That gap is visible as exactly the position judder this
		// whole architecture exists to remove. So: reserve the maximum, always.
		const popoverMaxHeight = computeHudPopoverMaxHeight(barHeight, availableHeight);
		const modalMaxHeight = computeHudModalMaxHeight(barHeight, availableHeight);
		const anchorEl = hudAnchorRef.current;
		anchorEl?.style.setProperty("--hud-popover-max-h", `${popoverMaxHeight}px`);
		anchorEl?.style.setProperty("--hud-modal-max-h", `${modalMaxHeight}px`);

		const { required, granted } = computeHudWindowSize({
			barWidth,
			barHeight,
			noticeHeight,
			availableHeight,
			stackMaxHeight: Math.max(popoverMaxHeight, modalMaxHeight),
		});

		const allocated = hudAllocatedSizeRef.current;
		// Grow the moment the content stops fitting. Shrink only once the content
		// has fallen a whole reserve below what was granted — that asymmetry is the
		// hysteresis: the bar can grow into its reserve (recording controls, a
		// longer source name) and back out again without a single native resize,
		// while a one-off bad reading (an unstyled first paint in dev, say) can't
		// leave the overlay permanently oversized.
		const needsResize =
			required.width > allocated.width ||
			required.height > allocated.height ||
			granted.width + HUD_GROWTH_RESERVE < allocated.width ||
			granted.height + HUD_GROWTH_RESERVE < allocated.height;
		if (!needsResize) {
			return;
		}

		allocated.width = granted.width;
		allocated.height = granted.height;
		window.electronAPI.setHudOverlaySize(granted.width, granted.height);
	}, [horizontalHudWidth, reportDirectionExclusionRectangles]);

	// One persistent observer; elements wire themselves up via callback refs as
	// they mount/unmount. Only the bar and the notice column are observed — the
	// popovers deliberately are not, since their space is already reserved.
	const hudResizeObserverRef = useRef<ResizeObserver | null>(null);
	useEffect(() => {
		const observer = new ResizeObserver(() => measureHudSize());
		hudResizeObserverRef.current = observer;
		if (hudBarRef.current) observer.observe(hudBarRef.current);
		if (hudNoticesRef.current) observer.observe(hudNoticesRef.current);
		measureHudSize();
		return () => {
			observer.disconnect();
			hudResizeObserverRef.current = null;
			lastDirectionExclusionSignatureRef.current = "";
			window.electronAPI?.setHudDirectionExclusionRectangles?.([]);
		};
	}, [measureHudSize]);

	const observeHudElement = useCallback(
		<T extends HTMLElement>(el: T | null, ref: React.MutableRefObject<T | null>) => {
			const observer = hudResizeObserverRef.current;
			if (ref.current && observer) observer.unobserve(ref.current);
			ref.current = el;
			if (el && observer) observer.observe(el);
			measureHudSize();
		},
		[measureHudSize],
	);
	const setHudBarEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, hudBarRef),
		[observeHudElement],
	);
	const setHudNoticesEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, hudNoticesRef),
		[observeHudElement],
	);
	const setPopoverEl = useCallback((el: HTMLDivElement | null) => {
		popoverRef.current = el;
	}, []);

	const hudIgnoreMouseEventsRef = useRef<boolean | undefined>(undefined);
	const setHudMouseEventsEnabled = useCallback(
		(enabled: boolean) => {
			const shouldIgnoreMouseEvents = !enabled && !isLinuxHud;
			if (hudIgnoreMouseEventsRef.current === shouldIgnoreMouseEvents) {
				return;
			}
			hudIgnoreMouseEventsRef.current = shouldIgnoreMouseEvents;
			window.electronAPI?.setHudOverlayIgnoreMouseEvents?.(shouldIgnoreMouseEvents);
		},
		[isLinuxHud],
	);

	useEffect(() => {
		setHudMouseEventsEnabled(false);
		return () => {
			window.electronAPI?.setHudOverlayIgnoreMouseEvents?.(false);
		};
	}, [setHudMouseEventsEnabled]);

	// A popover reaches beyond the bar, and the gap between the two would otherwise
	// flip the window back to click-through mid-travel — so hold the overlay
	// interactive for as long as one is open, and hand control back to the
	// pointer-move tracking once it closes.
	// A popover closed under a still pointer gets no pointermove, so check where
	// the pointer was: still on the pill means the next click belongs to the pill.
	const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
	useEffect(() => {
		const point = lastPointerRef.current;
		const underPointer = point ? document.elementFromPoint?.(point.x, point.y) : null;
		setHudMouseEventsEnabled(
			isPopoverOpen || Boolean(underPointer?.closest("[data-hud-interactive='true']")),
		);
	}, [isPopoverOpen, setHudMouseEventsEnabled]);

	const defaultSourceName = t("sourceSelector.defaultSourceName");
	const [selectedSource, setSelectedSource] = useState(defaultSourceName);
	const [hasSelectedSource, setHasSelectedSource] = useState(false);
	const [selectedSourceKind, setSelectedSourceKind] = useState<"display" | "window">("display");
	const [sourceReady, setSourceReady] = useState(false);
	const sourceGenerationRef = useRef(0);
	const recordAfterSourceSelectionRef = useRef(false);

	const applySelectedSource = useCallback(
		(source: ProcessedDesktopSource | null) => {
			if (source) {
				setSelectedSource(source.name);
				setHasSelectedSource(true);
				setSelectedSourceKind(source.id.startsWith("window:") ? "window" : "display");
				return;
			}

			setSelectedSource(defaultSourceName);
			setHasSelectedSource(false);
			setSelectedSourceKind("display");
		},
		[defaultSourceName],
	);

	// The main process pushes every change through `onSelectedSourceChanged`, so
	// this only needs one read to seed the initial value (plus one on focus, in
	// case a change was missed while this window was gone). The old 500ms poll ran
	// two IPC round-trips a second, forever, for a value that is event-driven.
	useEffect(() => {
		let cancelled = false;

		const refreshSelectedSource = async (initialize = false) => {
			if (!window.electronAPI) {
				return;
			}

			try {
				const generation = sourceGenerationRef.current;
				const source = initialize
					? await ensureDefaultRecordingSource(
							window.electronAPI,
							() => !cancelled && generation === sourceGenerationRef.current,
						)
					: await window.electronAPI.getSelectedSource();
				if (!cancelled) {
					applySelectedSource(source);
				}
			} catch (error) {
				console.warn("Failed to refresh selected source:", error);
			} finally {
				if (!cancelled && initialize) setSourceReady(true);
			}
		};

		void refreshSelectedSource(true);
		const onFocus = () => void refreshSelectedSource();
		window.addEventListener("focus", onFocus);

		return () => {
			cancelled = true;
			window.removeEventListener("focus", onFocus);
		};
	}, [applySelectedSource]);

	useEffect(() => {
		const cleanupSourceChanged = window.electronAPI?.onSelectedSourceChanged?.((source) => {
			sourceGenerationRef.current += 1;
			applySelectedSource(source);
			if (!recordAfterSourceSelectionRef.current || recording) {
				return;
			}

			recordAfterSourceSelectionRef.current = false;
			toggleRecording();
		});
		const cleanupSelectorClosed = window.electronAPI?.onSourceSelectorClosed?.(() => {
			recordAfterSourceSelectionRef.current = false;
		});

		return () => {
			cleanupSourceChanged?.();
			cleanupSelectorClosed?.();
		};
	}, [applySelectedSource, recording, toggleRecording]);

	// With screen access granted, the picker opens as a panel above the pill. The
	// standalone window remains the path that asks macOS for access first, and Linux's.
	const openSourceSelector = useCallback(
		async (kind?: SourcePickerKind) => {
			// Linux asks the main process every time: it is the authority on whether the
			// portal owns the choice, which the renderer may not know yet.
			if (
				window.electronAPI &&
				!portalOwnsSource &&
				window.electronAPI.getPlatform?.() !== "linux"
			) {
				if (!requireEntitlement("record")) {
					return { opened: false, reason: "entitlement-required" };
				}
				const access = await window.electronAPI.requestScreenAccess?.().catch(() => null);
				// Capture may have started while macOS answered; the source is fixed then.
				if (controlsLockedRef.current) {
					return { opened: false, reason: "controls-locked" };
				}
				if (access?.granted) {
					setIsDeviceSettingsOpen(false);
					setIsPeekOpen(false);
					setSourcePanelKind(kind);
					setIsSourcePanelOpen(true);
					return { opened: true };
				}
			}
			if (window.electronAPI) {
				return await openSourceSelectorWithPermissionRetry({
					openSourceSelector: () => window.electronAPI.openSourceSelector(),
					requestScreenAccess: () => window.electronAPI.requestScreenAccess(),
				});
			}

			return { opened: false, reason: "electron-api-unavailable" };
		},
		[portalOwnsSource],
	);

	const [sourcePanelKind, setSourcePanelKind] = useState<SourcePickerKind>();

	// Main warms its list about 1.5s after launch; the HUD copies it once it exists.
	useEffect(() => {
		const timer = window.setTimeout(() => void warmPickerSources(), 2500);
		return () => window.clearTimeout(timer);
	}, []);

	const closeSourcePanel = useCallback(() => {
		setIsSourcePanelOpen(false);
	}, []);

	// However the panel closes (its X, a click outside, Setup, Replay, or after a
	// choice), a pending "record once a source is chosen" ends with it. A choice
	// has already been delivered by then: main announces the new source before
	// the select call returns.
	const sourcePanelWasOpenRef = useRef(false);
	useEffect(() => {
		if (sourcePanelWasOpenRef.current && !isSourcePanelOpen) {
			recordAfterSourceSelectionRef.current = false;
		}
		sourcePanelWasOpenRef.current = isSourcePanelOpen;
	}, [isSourcePanelOpen]);

	// The source is fixed while capture runs, so the panel closes when it locks.
	useEffect(() => {
		if (controlsLocked) setIsSourcePanelOpen(false);
	}, [controlsLocked]);

	const toggleSourcePanel = useCallback(() => {
		if (isSourcePanelOpen) {
			closeSourcePanel();
			return;
		}
		void openSourceSelector();
	}, [closeSourcePanel, isSourcePanelOpen, openSourceSelector]);

	const handleRecordButtonClick = useCallback(
		(sourceSelectedOverride?: boolean) => {
			if (saving) {
				return;
			}
			if (!recording && !requireEntitlement("record")) return;
			// Linux never detours through the in-app picker: there is nothing for
			// it to select, and waiting for a selection that can never arrive left
			// the record button opening a modal instead of recording.
			const sourceSelected = portalOwnsSource || (sourceSelectedOverride ?? hasSelectedSource);
			if (!sourceSelected && !recording) {
				recordAfterSourceSelectionRef.current = true;
				void openSourceSelector()
					.then((result) => {
						if (result.opened) {
							return;
						}
						recordAfterSourceSelectionRef.current = false;
						// The main process is the authority on who owns the choice,
						// and it answers synchronously. `portalOwnsSource` is resolved
						// over IPC, so for a moment after mount it still reads false —
						// and a Record click landing in that window used to open a
						// selector that refused, leaving the click doing nothing at
						// all. Honouring the refusal starts the recording instead,
						// whatever the local state has caught up to.
						if (result.reason === "portal-owns-selection" && !recording) {
							toggleRecording();
						}
					})
					.catch(() => {
						recordAfterSourceSelectionRef.current = false;
					});
				return;
			}

			toggleRecording();
		},
		[hasSelectedSource, portalOwnsSource, openSourceSelector, recording, saving, toggleRecording],
	);
	const handleRecordClick = useCallback(() => {
		closePopovers();
		// Cancelling a start needs no entitlement or source check.
		if (starting && !recording) {
			toggleRecording();
			return;
		}
		handleRecordButtonClick();
	}, [closePopovers, handleRecordButtonClick, recording, starting, toggleRecording]);
	const showRemovedClipFeedback = useCallback((clip: RecordingSessionClip) => {
		removedClipFeedbackGenerationRef.current += 1;
		const generation = removedClipFeedbackGenerationRef.current;
		if (removedClipFeedbackTimerRef.current) {
			clearTimeout(removedClipFeedbackTimerRef.current);
		}
		setRemovedClipFeedback(clip);
		removedClipFeedbackTimerRef.current = setTimeout(() => {
			if (removedClipFeedbackGenerationRef.current !== generation) return;
			setRemovedClipFeedback(null);
			removedClipFeedbackTimerRef.current = null;
		}, REMOVED_CLIP_FEEDBACK_MS);
	}, []);
	const handleRemovePreviousClip = useCallback(async () => {
		const removedClip = await removePreviousClip();
		if (removedClip) showRemovedClipFeedback(removedClip);
	}, [removePreviousClip, showRemovedClipFeedback]);
	const handleUndoRemovedClip = useCallback(async () => {
		const clip = removedClipFeedback;
		if (!clip || restoringRemovedClipRef.current) return;
		const generation = removedClipFeedbackGenerationRef.current;
		restoringRemovedClipRef.current = true;
		try {
			const restoredClip = await restoreRemovedClip(clip.index);
			if (!restoredClip || removedClipFeedbackGenerationRef.current !== generation) return;
			if (removedClipFeedbackTimerRef.current) {
				clearTimeout(removedClipFeedbackTimerRef.current);
				removedClipFeedbackTimerRef.current = null;
			}
			setRemovedClipFeedback(null);
		} finally {
			restoringRemovedClipRef.current = false;
		}
	}, [removedClipFeedback, restoreRemovedClip]);

	useEffect(() => {
		if (recording) return;
		removedClipFeedbackGenerationRef.current += 1;
		if (removedClipFeedbackTimerRef.current) {
			clearTimeout(removedClipFeedbackTimerRef.current);
			removedClipFeedbackTimerRef.current = null;
		}
		setRemovedClipFeedback(null);
	}, [recording]);

	useEffect(
		() => () => {
			if (removedClipFeedbackTimerRef.current) {
				clearTimeout(removedClipFeedbackTimerRef.current);
			}
		},
		[],
	);

	useEffect(() => {
		if (!recording) return;
		const handleRecordingKeyDown = (event: KeyboardEvent) => {
			if (event.repeat) return;
			if (event.key === "ArrowUp" && canPeek && !peekOpen && !isDeviceSettingsOpen) {
				event.preventDefault();
				setIsDeviceSettingsOpen(false);
				setPeekInstant(true);
				setIsPeekOpen(true);
				return;
			}
			if (event.key !== "Backspace" || !canRemovePreviousClip) return;
			event.preventDefault();
			void handleRemovePreviousClip();
		};
		window.addEventListener("keydown", handleRecordingKeyDown);
		return () => window.removeEventListener("keydown", handleRecordingKeyDown);
	}, [
		canPeek,
		canRemovePreviousClip,
		handleRemovePreviousClip,
		isDeviceSettingsOpen,
		peekOpen,
		recording,
	]);

	useEffect(() => {
		return window.electronAPI?.onHudToggleRecordingPause?.(() => {
			if (!recording || saving || clipFinalizing || !canPauseRecording) return;
			togglePaused();
		});
	}, [canPauseRecording, clipFinalizing, recording, saving, togglePaused]);

	const sendHudOverlayHide = useCallback(() => {
		window.electronAPI?.hudOverlayHide?.();
	}, []);
	const sendHudOverlayClose = useCallback(() => {
		if (starting || saving || clipFinalizing) return;
		if (recording) {
			window.electronAPI?.hudOverlayClose?.();
			return;
		}
		if (returnToReview) {
			void window.electronAPI?.switchToEditor();
			return;
		}
		void window.electronAPI?.returnToEditorIfRecordingWorkspace?.().then((result) => {
			if (!result.returned) window.electronAPI?.hudOverlayClose?.();
		});
	}, [recording, returnToReview, starting, saving, clipFinalizing]);
	const openStudio = useCallback(() => {
		if (!saving) window.electronAPI.switchToEditor();
	}, [saving]);
	useEffect(() => {
		if (starting || recording || saving || clipFinalizing || isPopoverOpen) return;
		const returnToEditor = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			if (returnToReview) void window.electronAPI?.switchToEditor();
			else void window.electronAPI?.returnToEditorIfRecordingWorkspace?.();
		};
		window.addEventListener("keydown", returnToEditor);
		return () => window.removeEventListener("keydown", returnToEditor);
	}, [isPopoverOpen, starting, recording, saving, clipFinalizing, returnToReview]);
	const openNotes = useCallback(() => {
		if (!saving) window.electronAPI.openNotes();
	}, [saving]);

	const toggleSystemAudio = useCallback(() => {
		if (controlsLocked) return;
		const enabled = !systemAudioEnabled;
		setSystemAudioEnabled(enabled);
		void window.electronAPI?.setRecordingPrefs?.({
			systemAudioEnabled: enabled,
		});
	}, [controlsLocked, setSystemAudioEnabled, systemAudioEnabled]);

	const toggleCursorMode = useCallback(() => {
		if (controlsLocked) return;
		const mode = cursorCaptureMode === "editable-overlay" ? "system" : "editable-overlay";
		setCursorCaptureMode(mode);
		void window.electronAPI?.setRecordingPrefs?.({ cursorCaptureMode: mode });
	}, [controlsLocked, cursorCaptureMode, setCursorCaptureMode]);

	const toggleMicrophone = useCallback(() => {
		if (controlsLocked) return;
		const enabled = !microphoneEnabled;
		setMicrophoneEnabled(enabled);
		void window.electronAPI?.setRecordingPrefs?.({ micEnabled: enabled });
	}, [controlsLocked, microphoneEnabled, setMicrophoneEnabled]);

	const toggleWebcam = useCallback(() => {
		if (controlsLocked) return;
		const enabled = !webcamEnabled;
		// If the settings panel owns a temporary verification stream, unmount it
		// before the recorder acquires the same device.
		if (enabled) closePopovers();
		void setWebcamEnabled(enabled).then((applied) => {
			if (applied) void window.electronAPI?.setRecordingPrefs?.({ camEnabled: enabled });
		});
	}, [closePopovers, controlsLocked, setWebcamEnabled, webcamEnabled]);

	// Selecting a device never switches it on. If the device is already live the
	// recorder re-acquires on the id change; if it isn't, this just records which
	// one the next toggle should use.
	const handleSelectMicDevice = useCallback(
		(device: MicrophoneDevice) => {
			if (controlsLocked) return;
			setSelectedMicId(device.deviceId);
			setMicrophoneDeviceId(device.deviceId);
			setMicrophoneDeviceName(device.label);
			void window.electronAPI?.setRecordingPrefs?.({
				micDeviceId: device.deviceId,
			});
		},
		[controlsLocked, setMicrophoneDeviceId, setMicrophoneDeviceName, setSelectedMicId],
	);

	const handleSelectCameraDevice = useCallback(
		(device: CameraDevice) => {
			if (controlsLocked) return;
			setSelectedCameraId(device.deviceId);
			setWebcamDeviceId(device.deviceId);
			setWebcamDeviceName(device.label);
			void window.electronAPI?.setRecordingPrefs?.({
				camDeviceId: device.deviceId,
			});
		},
		[controlsLocked, setSelectedCameraId, setWebcamDeviceId, setWebcamDeviceName],
	);

	const handleSelectRecordingQuality = useCallback(
		(quality: RecordingQuality) => {
			if (controlsLocked) return;
			setRecordingQuality(quality);
			void window.electronAPI?.setRecordingPrefs?.({ recordingQuality: quality });
		},
		[controlsLocked, setRecordingQuality],
	);

	const handleSelectWebcamFormat = useCallback(
		(format: WebcamFormat | "auto") => {
			if (controlsLocked) return;
			if (format === "auto") {
				setWebcamFormatAuto(true);
				void window.electronAPI?.setRecordingPrefs?.({ camFormatAuto: true });
				return;
			}
			setWebcamFormat(format);
			// A Standard choice (or Standard adopting the camera's mode) must not take
			// High off Automatic; only a pick made on High does.
			if (recordingQuality !== "high") {
				void window.electronAPI?.setRecordingPrefs?.({ camFormat: format });
				return;
			}
			setWebcamFormatAuto(false);
			void window.electronAPI?.setRecordingPrefs?.({ camFormat: format, camFormatAuto: false });
		},
		[controlsLocked, recordingQuality, setWebcamFormat, setWebcamFormatAuto],
	);

	// Setup opens at any time except a transition; while capture is live its
	// rows are locked, so it reads as status rather than offering a change.
	const toggleDeviceSettings = useCallback(() => {
		if (starting || saving) return;
		setIsPeekOpen(false);
		setIsSourcePanelOpen(false);
		setIsDeviceSettingsOpen((open) => !open);
	}, [saving, starting]);

	const togglePeek = useCallback(() => {
		setIsDeviceSettingsOpen(false);
		setIsSourcePanelOpen(false);
		setPeekInstant(false);
		setIsPeekOpen((open) => !open);
	}, []);

	const closePeek = useCallback(() => {
		setIsPeekOpen(false);
	}, []);

	const closeDeviceSettings = useCallback(() => {
		setIsDeviceSettingsOpen(false);
	}, []);

	const handleSelectLocale = useCallback(
		(nextLocale: string) => {
			setLocale(nextLocale as Parameters<typeof setLocale>[0]);
			resolveSystemLocaleSuggestion();
		},
		[resolveSystemLocaleSuggestion, setLocale],
	);

	const enableHudMouseEvents = useCallback(() => {
		setHudMouseEventsEnabled(true);
	}, [setHudMouseEventsEnabled]);

	// ---------------------------------------------------------------------------
	// Dragging
	//
	// Deltas are absolute (total travel since pointerdown), not incremental: the
	// main process pins the window's origin at drag start and every move is
	// `origin + delta`. Accumulating per-frame deltas instead meant every rounded
	// setPosition compounded, and a dropped message drifted permanently. Absolute
	// deltas are self-correcting, and there's no requestAnimationFrame in the path
	// — pointermove is already delivered at most once per frame, so the rAF only
	// ever added a frame of latency to a gesture the user is watching.
	// ---------------------------------------------------------------------------
	const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
	const lastDragDeltaRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

	const handleHudDragPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			event.stopPropagation();
			setHudMouseEventsEnabled(true);
			event.currentTarget.setPointerCapture(event.pointerId);
			dragOriginRef.current = { x: event.screenX, y: event.screenY };
			lastDragDeltaRef.current = { x: 0, y: 0 };
			isDraggingHudRef.current = true;
			window.electronAPI?.beginHudOverlayDrag?.();
		},
		[setHudMouseEventsEnabled],
	);

	const endHudDrag = useCallback(() => {
		if (!dragOriginRef.current) return;
		dragOriginRef.current = null;
		isDraggingHudRef.current = false;
		window.electronAPI?.endHudOverlayDrag?.();
		measureHudSize();
	}, [measureHudSize]);

	const handleHudDragPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const origin = dragOriginRef.current;
			if (!origin) return;
			// A release that never arrived (the grip swapped between idle and
			// recording mid-press) must not leave the window following the pointer.
			if ((event.buttons & 1) === 0) {
				endHudDrag();
				return;
			}
			const deltaX = event.screenX - origin.x;
			const deltaY = event.screenY - origin.y;
			const last = lastDragDeltaRef.current;
			if (last.x === deltaX && last.y === deltaY) return;
			lastDragDeltaRef.current = { x: deltaX, y: deltaY };
			window.electronAPI?.dragHudOverlayTo?.(deltaX, deltaY);
		},
		[endHudDrag],
	);

	const handleHudDragPointerEnd = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			endHudDrag();
		},
		[endHudDrag],
	);

	// The idle and recording pills each render their own grip, so a press can
	// outlive the element that started it. Any switch ends the drag.
	const gripRecordingRef = useRef(pillRecording);
	useEffect(() => {
		if (gripRecordingRef.current === pillRecording) return;
		gripRecordingRef.current = pillRecording;
		endHudDrag();
	}, [pillRecording, endHudDrag]);

	const handleRootPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			lastPointerRef.current = { x: event.clientX, y: event.clientY };
			// The pointer is captured by the drag handle anyway; skip the DOM walk.
			if (isDraggingHudRef.current) return;
			const target = event.target as HTMLElement | null;
			setHudMouseEventsEnabled(
				isPopoverOpen ||
					Boolean(target?.closest("[data-hud-interactive='true'], [data-sonner-toaster]")),
			);
		},
		[isPopoverOpen, setHudMouseEventsEnabled],
	);

	const handlePointerLeave = useCallback(() => {
		lastPointerRef.current = null;
		if (!isPopoverOpen) {
			setHudMouseEventsEnabled(false);
		}
	}, [isPopoverOpen, setHudMouseEventsEnabled]);

	const dismissSoftwareFallbackForever = useCallback(() => {
		dismissSoftwareEncoderFallbackNotice(true);
	}, [dismissSoftwareEncoderFallbackNotice]);
	const dismissSoftwareFallbackOnce = useCallback(() => {
		dismissSoftwareEncoderFallbackNotice();
	}, [dismissSoftwareEncoderFallbackNotice]);

	// On Linux the ScreenCast portal owns the choice, so there is no in-app
	// selection to name and none to demand: the idle label says what pressing
	// record will do, and the recording label stays neutral because the portal
	// reports a KIND, never a window title. Naming a source we were never told
	// is what put a window's name on a full-screen recording.
	const prewarmCapture = useCallback(() => {
		void window.electronAPI.prewarmNativeMacCapture?.().catch(() => undefined);
	}, []);
	const recordLabel = starting
		? t("recording.starting")
		: saving
			? t("recording.saving")
			: portalOwnsSource
				? recording
					? t("recording.inProgress")
					: t("recording.systemPicker")
				: hasSelectedSource || recording
					? selectedSource
					: t("recording.selectSource");

	const recordAccessibleLabel =
		!recording && !starting && !saving && hasSelectedSource && !portalOwnsSource
			? editorT("recordingReview.record")
			: undefined;

	// Stable identity, or the panel's memo boundary would break on every parent
	// render — including the once-a-second one during a recording.
	const deviceSettingsLabels = useMemo<HudDeviceSettingsLabels>(
		() => ({
			title: t("deviceSettings.title"),
			recordingQuality: t("deviceSettings.recordingQuality"),
			qualityHigh: t("deviceSettings.qualityHigh"),
			qualityStandard: t("deviceSettings.qualityStandard"),
			cameraAutomatic: t("deviceSettings.cameraAutomatic"),
			done: t("deviceSettings.done"),
			microphone: t("audio.inputDevice"),
			camera: t("webcam.cameraDevice"),
			micLevel: t("deviceSettings.micLevel"),
			micHint: t("deviceSettings.micHint"),
			noMicrophones: t("deviceSettings.noMicrophones"),
			searching: t("webcam.searching"),
			noCameras: t("webcam.noneFound"),
			cameraUnavailable: t("webcam.unavailable"),
			cameraQuality: t("deviceSettings.cameraQuality"),
			preview: t("deviceSettings.preview"),
			previewUnavailable: t("deviceSettings.previewUnavailable"),
			systemAudioName: t("audio.systemAudio"),
			microphoneName: t("audio.microphone"),
			cameraName: t("webcam.camera"),
			on: t("audio.on"),
			off: t("audio.off"),
			source: t("deviceSettings.source"),
			editableCursor: t("deviceSettings.editableCursor"),
			language: t("deviceSettings.language"),
			hide: t("tooltips.hideHUD"),
			close: hasReviewReturn && !recording ? t("tooltips.openStudio") : t("tooltips.closeApp"),
			lockedHint: t("deviceSettings.lockedHint"),
			display: t("deviceSettings.display"),
			window: t("deviceSettings.window"),
		}),
		[hasReviewReturn, recording, t],
	);

	const peekLabels = useMemo<HudClipPeekLabels>(
		() => ({
			title: t("peek.title"),
			clipOf: (current, total) => t("peek.clipOf", { current, total }),
			play: t("peek.play"),
			pause: t("peek.pause"),
			mute: t("peek.mute"),
			unmute: t("peek.unmute"),
			seek: t("peek.seek"),
		}),
		[t],
	);

	const transitionLocked = starting || saving || clipFinalizing;
	// The recorder's restart/cancel are recreated every render; route them through
	// a ref so the setup panel's memo boundary survives the timer ticks.
	const recorderActionsRef = useRef({ restartRecording, cancelRecording });
	recorderActionsRef.current = { restartRecording, cancelRecording };
	const handleRestartRecording = useCallback(() => {
		recorderActionsRef.current.restartRecording();
	}, []);
	const handleCancelRecording = useCallback(() => {
		recorderActionsRef.current.cancelRecording();
	}, []);
	const setupFooterLead = useMemo(
		() =>
			isLinuxHud ? null : (
				<button
					type="button"
					className={styles.hudSetupFooterButton}
					disabled={saving}
					onClick={openNotes}
				>
					<NotepadText size={15} aria-hidden />
					{t("setup.notes")}
				</button>
			),
		[isLinuxHud, openNotes, saving, t],
	);

	const setupFooter = useMemo(
		() => (
			<>
				{recording ? (
					<>
						<button
							type="button"
							className={styles.hudSetupFooterButton}
							disabled={transitionLocked}
							onClick={handleRestartRecording}
						>
							<RotateCcw size={15} aria-hidden />
							{t("setup.restart")}
						</button>
						<button
							type="button"
							data-variant="danger"
							className={styles.hudSetupFooterButton}
							disabled={transitionLocked}
							onClick={handleCancelRecording}
						>
							<X size={15} aria-hidden />
							{t("setup.discard")}
						</button>
					</>
				) : (
					<button
						type="button"
						data-testid="launch-open-studio-button"
						className={styles.hudSetupFooterButton}
						disabled={saving}
						onClick={openStudio}
					>
						<Clapperboard size={15} aria-hidden />
						{t("recording.recordings")}
					</button>
				)}
			</>
		),
		[
			handleCancelRecording,
			handleRestartRecording,
			openStudio,
			recording,
			saving,
			t,
			transitionLocked,
		],
	);

	// Display picks the main display in one click; with a display already chosen
	// it opens the picker so another display can be chosen.
	const selectDisplaySource = useCallback(async () => {
		if (selectedSourceKind === "display" || !window.electronAPI?.getSources) {
			void openSourceSelector();
			return;
		}
		try {
			const sources = await window.electronAPI.getSources({
				types: ["screen"],
				thumbnailSize: { width: 1, height: 1 },
				fetchWindowIcons: false,
			});
			const display = sources.find((source) => source.id.startsWith("screen:"));
			if (!display) {
				void openSourceSelector();
				return;
			}
			sourceGenerationRef.current += 1;
			applySelectedSource(await window.electronAPI.selectSource(display));
		} catch (error) {
			console.warn("Failed to select the display:", error);
			toast.error(t("sourceSelector.selectFailed"));
		}
	}, [applySelectedSource, openSourceSelector, selectedSourceKind, t]);

	const setupExtras = useMemo<HudSetupExtras>(
		() => ({
			sourceLabel: portalOwnsSource ? undefined : selectedSource,
			sourceKind: selectedSourceKind,
			sourceDisabled: controlsLocked,
			onSelectDisplay: portalOwnsSource ? undefined : () => void selectDisplaySource(),
			onOpenSource: portalOwnsSource
				? undefined
				: () => {
						setIsDeviceSettingsOpen(false);
						void openSourceSelector("windows");
					},
			editableCursor: cursorCaptureMode === "editable-overlay",
			onToggleCursor: supportsCursorModeToggle ? toggleCursorMode : undefined,
			locales: recording ? undefined : AVAILABLE_LOCALES,
			activeLocale: locale,
			getLocaleName: getLocaleName as (loc: string) => string,
			onSelectLocale: handleSelectLocale,
			onHide: sendHudOverlayHide,
			onQuit: recording || hasReviewReturn ? undefined : sendHudOverlayClose,
			windowControlsDisabled: transitionLocked,
			footerLead: setupFooterLead,
			footer: setupFooter,
		}),
		[
			hasReviewReturn,
			recording,
			selectDisplaySource,
			selectedSourceKind,
			sendHudOverlayClose,
			setupFooterLead,
			controlsLocked,
			cursorCaptureMode,
			handleSelectLocale,
			locale,
			openSourceSelector,
			portalOwnsSource,
			selectedSource,
			sendHudOverlayHide,
			setupFooter,
			supportsCursorModeToggle,
			toggleCursorMode,
			transitionLocked,
		],
	);

	// The idle pill shows the mic's live level so a dead or wrong mic is obvious
	// before Record, only while the pill is on screen. Setup runs its own meter,
	// and capture owns the mic once a take starts.
	const [hudVisible, setHudVisible] = useState(true);
	useEffect(() => window.electronAPI?.onHudVisibilityChanged?.(setHudVisible), []);
	const idleMicMeterOn =
		hudVisible &&
		microphoneEnabled &&
		!pillRecording &&
		!isDeviceSettingsOpen &&
		!isMicDevicesLoading &&
		micDevices.length > 0;
	const { level: idleMicLevel } = useAudioLevelMeter({
		enabled: idleMicMeterOn,
		deviceId: microphoneDeviceId || selectedMicId,
	});

	const hasNotices = Boolean(systemLocaleSuggestion) || softwareEncoderFallbackNoticeVisible;
	const previousClip = [...recordedClips].reverse().find((clip) => !clip.removed) ?? null;
	const removePreviousLabel = t("recording.removePreviousClip");
	const removePreviousTooltip = previousClip
		? t("recording.removePreviousClipWithDuration", {
				duration: formatClipDuration(previousClip.durationMs),
			})
		: removePreviousLabel;

	const dragHandleProps = {
		nativeDrag: isLinuxHud,
		onPointerDown: handleHudDragPointerDown,
		onPointerMove: handleHudDragPointerMove,
		onPointerEnd: handleHudDragPointerEnd,
	};

	return (
		// Avoid w-screen/h-screen: 100vw can exceed the inner layout width when scrollbars
		// affect the viewport (Windows), causing a horizontal scrollbar (issue #305).
		<div
			// No `electronDrag` here. This root is the whole transparent window, nearly
			// all of it invisible, and a drag region is honoured by the compositor
			// whether or not anything is painted there. The drag region belongs on the
			// grab handle, which is where it lives.
			className="h-full w-full min-w-0 max-w-full overflow-x-hidden overflow-y-hidden bg-transparent"
			onPointerMove={handleRootPointerMove}
			onPointerLeave={handlePointerLeave}
		>
			{/* Recorder errors appear right above the pill, inside this root so a
			    pointer over a toast makes the click-through window clickable. */}
			<Toaster position="bottom-center" offset={HUD_TOAST_OFFSET} duration={6000} />
			{/* One bottom-anchored stack: the pill, then whatever floats above it.
			    Everything is laid out by flexbox relative to the pill, so no popover
			    needs a measured position and none of them can move the window. */}
			<div ref={hudAnchorRef} className={styles.hudAnchor}>
				<div
					ref={setHudBarEl}
					data-hud-interactive="true"
					data-recording-layout={pillRecording ? "recording" : "idle"}
					data-starting={starting && !recordingHudActive}
					className={`${styles.hudBar} ${pillRecording ? styles.hudPillRecording : styles.hudPillIdle}`}
					onPointerEnter={enableHudMouseEvents}
					onPointerDown={enableHudMouseEvents}
					onMouseEnter={enableHudMouseEvents}
					onMouseLeave={handlePointerLeave}
				>
					{pillRecording ? (
						<div key="recording" className={`${styles.hudPillRow} ${styles.hudContentEnter}`}>
							<HudCompactPauseButton
								paused={presentation.paused}
								busy={clipFinalizing}
								disabled={saving || clipFinalizing || !canPauseRecording}
								label={
									presentation.paused ? t("tooltips.resumeRecording") : t("tooltips.pauseRecording")
								}
								onClick={togglePaused}
							/>
							<HudDragHandle {...dragHandleProps}>
								<HudCompactTimer
									elapsedSeconds={presentation.elapsedSeconds}
									paused={presentation.paused || saving || !recordingHudActive}
								/>
							</HudDragHandle>
							<HudStopButton
								saving={saving}
								disabled={saving || clipFinalizing}
								label={
									recordingHudActive ? t("tooltips.stopRecording") : t("tooltips.cancelRecording")
								}
								savingLabel={t("recording.saving")}
								onClick={handleRecordClick}
							/>
							<HudRemovePreviousClipButton
								disabled={saving || clipFinalizing || !canRemovePreviousClip}
								label={removePreviousLabel}
								tooltip={removePreviousTooltip}
								onClick={handleRemovePreviousClip}
							/>
							<HudExpandButton
								expanded={peekOpen}
								disabled={!canPeek}
								label={t("peek.open")}
								onClick={togglePeek}
							/>
							<HudSettingsButton
								disabled={starting || saving}
								expanded={isDeviceSettingsOpen}
								label={t("deviceSettings.title")}
								onClick={toggleDeviceSettings}
							/>
						</div>
					) : (
						<div key="idle" className={`${styles.hudPillRow} ${styles.hudContentEnter}`}>
							<HudDragHandle {...dragHandleProps} label="Klippt">
								<HudBrandMark />
							</HudDragHandle>
							{/* No source chip on Linux: the ScreenCast portal owns the choice and
							    asks when recording starts, so nothing picked here could reach the
							    capture. */}
							{portalOwnsSource ? (
								<span className="flex-1" />
							) : (
								<HudSourceChip
									label={selectedSource}
									kind={selectedSourceKind}
									expanded={isSourcePanelOpen}
									disabled={controlsLocked}
									onClick={toggleSourcePanel}
									onIntent={isLinuxHud ? undefined : prefetchPickerSources}
								/>
							)}
							<HudSystemAudioButton
								enabled={systemAudioEnabled}
								disabled={controlsLocked}
								label={
									systemAudioEnabled ? t("audio.disableSystemAudio") : t("audio.enableSystemAudio")
								}
								onClick={toggleSystemAudio}
							/>
							<HudMicButton
								enabled={microphoneEnabled}
								disabled={controlsLocked}
								label={
									microphoneEnabled ? t("audio.disableMicrophone") : t("audio.enableMicrophone")
								}
								level={idleMicMeterOn ? idleMicLevel : undefined}
								onClick={toggleMicrophone}
							/>
							<HudCameraButton
								enabled={webcamEnabled}
								disabled={controlsLocked}
								label={webcamEnabled ? t("webcam.disableWebcam") : t("webcam.enableWebcam")}
								onClick={toggleWebcam}
							/>
							<HudSettingsButton
								disabled={starting || saving}
								expanded={isDeviceSettingsOpen}
								label={t("deviceSettings.title")}
								onClick={toggleDeviceSettings}
							/>
							<HudCompactRecordButton
								disabled={
									starting ||
									saving ||
									!sourceReady ||
									!preferencesReady ||
									(microphoneEnabled && isMicDevicesLoading)
								}
								label={recordLabel}
								accessibleLabel={recordAccessibleLabel}
								onClick={handleRecordClick}
								onIntent={prewarmCapture}
							/>
						</div>
					)}
				</div>

				{(isPopoverOpen ||
					setupPresence.present ||
					sourcePresence.present ||
					canPeek ||
					hasNotices ||
					shownRemovedClip) && (
					// column-reverse: first child sits closest to the bar.
					<div className={styles.hudAbove}>
						{setupPresence.present && (
							<HudDeviceSettings
								closing={setupPresence.closing}
								micDevices={micDevices}
								cameraDevices={cameraDevices}
								activeMicId={microphoneDeviceId || selectedMicId}
								activeCameraId={webcamDeviceId || selectedCameraId}
								cameraEnabled={webcamEnabled}
								cameraStream={webcamPreviewStream}
								recordingQuality={recordingQuality}
								onSelectRecordingQuality={handleSelectRecordingQuality}
								webcamFormat={webcamFormat}
								webcamFormatAuto={webcamFormatAuto}
								cameraLoading={isCameraDevicesLoading}
								cameraError={cameraDevicesError}
								labels={deviceSettingsLabels}
								systemAudioEnabled={systemAudioEnabled}
								microphoneEnabled={microphoneEnabled}
								controlsLocked={controlsLocked}
								onToggleSystemAudio={toggleSystemAudio}
								onToggleMicrophone={toggleMicrophone}
								onToggleCamera={toggleWebcam}
								extras={setupExtras}
								onSelectMic={handleSelectMicDevice}
								onSelectCamera={handleSelectCameraDevice}
								onSelectWebcamFormat={handleSelectWebcamFormat}
								onClose={closeDeviceSettings}
								panelRef={isDeviceSettingsOpen ? setPopoverEl : undefined}
							/>
						)}

						{sourcePresence.present && (
							<SourcePicker
								variant="panel"
								initialKind={sourcePanelKind}
								className={styles.hudPanel}
								closing={sourcePresence.closing}
								onClose={closeSourcePanel}
								onChosen={() => setIsSourcePanelOpen(false)}
								panelRef={isSourcePanelOpen ? setPopoverEl : undefined}
							/>
						)}

						{canPeek && (
							<HudClipPeek
								clips={presentation.recordedClips}
								labels={peekLabels}
								open={peekOpen}
								instant={peekInstant}
								panelRef={peekOpen ? setPopoverEl : undefined}
								onClose={closePeek}
							/>
						)}

						{(shownRemovedClip || hasNotices) && (
							<div
								ref={setHudNoticesEl}
								data-testid="hud-notice-column"
								className={styles.hudNoticeColumn}
							>
								{shownRemovedClip && (
									<div
										data-hud-interactive="true"
										data-testid="clip-removal-feedback"
										data-closing={removedClipPresence.closing}
										className={`${styles.clipUndoNotice} ${styles.electronNoDrag}`}
										onPointerEnter={enableHudMouseEvents}
										role="status"
									>
										<span>{t("recording.clipRemoved")}</span>
										<span className={styles.clipUndoDuration}>
											{formatClipDuration(shownRemovedClip.durationMs)}
										</span>
										<button
											type="button"
											className={styles.clipUndoButton}
											onClick={handleUndoRemovedClip}
										>
											{commonT("actions.undo")}
										</button>
									</div>
								)}

								{systemLocaleSuggestion && (
									<HudNotice
										title={t("systemLanguagePrompt.title")}
										description={t("systemLanguagePrompt.description", {
											language: suggestedLanguageName,
										})}
										dismissLabel={t("systemLanguagePrompt.keepDefault")}
										confirmLabel={t("systemLanguagePrompt.switch", {
											language: suggestedLanguageName,
										})}
										onDismiss={dismissSystemLocaleSuggestion}
										onConfirm={acceptSystemLocaleSuggestion}
									/>
								)}

								{softwareEncoderFallbackNoticeVisible && (
									<HudNotice
										title={t("softwareEncoderFallback.title")}
										description={t("softwareEncoderFallback.description")}
										dismissLabel={t("softwareEncoderFallback.dontShowAgain")}
										confirmLabel={t("softwareEncoderFallback.dismiss")}
										onDismiss={dismissSoftwareFallbackForever}
										onConfirm={dismissSoftwareFallbackOnce}
									/>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

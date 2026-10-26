import { Captions, Clapperboard, NotepadText, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { getAvailableLocales, getLocaleName } from "@/i18n/loader";
import { requireEntitlement } from "@/lib/entitlements/store";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { nativeBridgeClient } from "@/native";
import { formatTimePadded } from "@/utils/timeUtils";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import { type CameraDevice, useCameraDevices } from "../../hooks/useCameraDevices";
import { useCameraPreviewFrameBridge } from "../../hooks/useCameraPreviewFrameBridge";
import { type MicrophoneDevice, useMicrophoneDevices } from "../../hooks/useMicrophoneDevices";
import { usePortalOwnsSource } from "../../hooks/usePortalOwnsSource";
import { useScreenRecorder } from "../../hooks/useScreenRecorder";
import {
	type CapturePermissionKind,
	type CapturePermissions,
	permissionStep,
} from "../../lib/capturePermissions";
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
	HudDockMark,
	HudDragHandle,
	HudExpandButton,
	HudMicButton,
	HudNotice,
	HudRemovePreviousClipButton,
	HudSettingsButton,
	HudSourceChip,
	HudStopButton,
	HudSystemAudioButton,
	HudTuckButton,
} from "./HudControls";
import {
	HudDeviceSettings,
	type HudDeviceSettingsLabels,
	type HudSetupExtras,
} from "./HudDeviceSettings";
import { type HudPermissionLabels, HudPermissionPanel } from "./HudPermissionPanel";
import {
	computeHudBarMaxHeight,
	computeHudModalMaxHeight,
	computeHudPlacement,
	computeHudPopoverMaxHeight,
	computeHudWindowSize,
	fitHudStackCap,
	HUD_GROWTH_RESERVE,
	HUD_POPOVER_GAP,
	HUD_POPOVER_MIN_HEIGHT,
	HUD_STACK_GAP,
	type HudStackPlacement,
} from "./hudGeometry";
import styles from "./LaunchWindow.module.css";
import { openSourceSelectorWithPermissionRetry } from "./openSourceSelectorFlow";
import {
	prefetchPickerSources,
	SourcePicker,
	type SourcePickerKind,
	warmPickerSources,
} from "./SourceSelector";
import { useHudDockInteraction } from "./useHudDockInteraction";
import { usePresence } from "./usePresence";
import { useRecordingHudPresentation } from "./useRecordingHudPresentation";

// Locale list is computed once at module load; keeping the reference stable lets
// the setup panel sit behind a memo boundary.
const AVAILABLE_LOCALES = getAvailableLocales();

async function readCapturePermissions(): Promise<CapturePermissions | null> {
	try {
		return (await window.electronAPI?.getCapturePermissions?.()) ?? null;
	} catch {
		return null;
	}
}

// Used only when the renderer can't see a real display (tests, headless).
const FALLBACK_SCREEN_HEIGHT = 1080;
const FALLBACK_SCREEN_WIDTH = 1920;
const HUD_PILL_WIDTH = 424;
const HUD_PILL_HEIGHT = 50;
/** How long the tab takes to slide back into its edge; matches .hudDockTab[data-closing]. */
const HUD_DOCK_TAB_EXIT_MS = 160;
/** How long the pill takes to slide out of sight; matches .hudBar[data-tucked]. */
const HUD_TUCK_SLIDE_MS = 240;

type HudDockSide = "left" | "right" | "top";
/** Toasts sit next to the pill, which is centred in the window: half its height and one stack gap. */
const HUD_TOAST_OFFSET = `calc(50% + ${HUD_PILL_HEIGHT / 2 + HUD_STACK_GAP}px)`;
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

/** Top edge of the display's work area in screen coordinates (below the menu bar). */
function getAvailableScreenTop(): number {
	if (typeof window === "undefined" || !("availTop" in window.screen)) return 0;
	const top = window.screen.availTop;
	return typeof top === "number" && Number.isFinite(top) ? top : 0;
}

/** Painted HUD pixels: the pill, its panels and notices, toasts, and select menus. */
function isPaintedHudSurface(target: Element | null): boolean {
	return Boolean(
		target?.closest(
			"[data-hud-interactive='true'], [data-sonner-toast], [data-klippt-select-content]",
		),
	);
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
		selectRecordingSource,
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
	// The idle pill can fold down to the mark and Record. The choice is remembered;
	// recording always uses the full recording pill.
	const [hudMinimized, setHudMinimized] = useState(() => loadUserPreferences().hudMinimized);
	// Linux hands the grip to the compositor as a drag region, so it gets no clicks.
	const canMinimize = !isLinuxHud;
	// The pill can tuck into a side or the top edge as a tab, out of the way until it is
	// needed, recording or not. Main tucks it in when a drag shoves it past the edge.
	// Hovering the tab slides the whole pill back out until the pointer leaves it.
	const [hudDock, setHudDock] = useState<HudDockSide | null>(null);
	const dockedSide = canMinimize ? hudDock : null;
	const [hudDragging, setHudDragging] = useState(false);
	const pillMinimized = canMinimize && hudMinimized && !pillRecording && dockedSide !== "top";
	// The tuck button slides the pill up out of sight first; main then moves the
	// hidden pill to the top edge and the tab slides down there.
	const [tuckingTop, setTuckingTop] = useState(false);
	const dockedSideRef = useRef(dockedSide);
	dockedSideRef.current = dockedSide;
	// Tucking back in on launch happens before the pill is ever seen, so it does not slide.
	const [dockInstant, setDockInstant] = useState(false);
	useEffect(() => {
		if (!dockInstant) return;
		const frame = requestAnimationFrame(() => setDockInstant(false));
		return () => cancelAnimationFrame(frame);
	}, [dockInstant]);
	const dockPresence = usePresence(dockedSide !== null, HUD_DOCK_TAB_EXIT_MS);
	const lastDockSideRef = useRef<HudDockSide>("left");
	if (dockedSide) lastDockSideRef.current = dockedSide;
	const shownDockSide = dockPresence.present ? lastDockSideRef.current : null;

	const keptClipCount = presentation.recordedClips.filter((clip) => !clip.removed).length;
	// The replay reads finished clip files, so it exists only while a completed
	// Pause has handed every kept clip to disk.
	const canPeek =
		recording && presentation.paused && !saving && !clipFinalizing && keptClipCount > 0;
	const peekOpen = isPeekOpen && canPeek;
	// Shown before any macOS capture prompt: what Klippt needs, and why.
	const [permissionPanelOpen, setPermissionPanelOpen] = useState(false);
	const [capturePermissions, setCapturePermissions] = useState<CapturePermissions | null>(null);
	const [permissionRequestBusy, setPermissionRequestBusy] = useState(false);
	const pendingPermissionActionRef = useRef<(() => void) | null>(null);
	const permissionPresence = usePresence(permissionPanelOpen, 150);
	const permissionNeeds = useMemo(
		() => ({ microphone: microphoneEnabled, camera: webcamEnabled }),
		[microphoneEnabled, webcamEnabled],
	);
	const permissionNeedsRef = useRef(permissionNeeds);
	permissionNeedsRef.current = permissionNeeds;
	const isPopoverOpen =
		isDeviceSettingsOpen || peekOpen || isSourcePanelOpen || permissionPanelOpen;
	const {
		expanded: dockPeek,
		pinned: dockPinned,
		samplePointer,
		setFocusWithin,
		togglePinned,
		collapse: collapseDock,
	} = useHudDockInteraction({
		docked: Boolean(dockedSide),
		dragging: hudDragging,
		panelOpen: isPopoverOpen,
	});
	const tuckedSide = dockedSide && !dockPeek ? dockedSide : tuckingTop ? "top" : null;
	const setupPresence = usePresence(isDeviceSettingsOpen, 150);
	const sourcePresence = usePresence(isSourcePanelOpen, 150);
	// Setup and Source are two pages of one popover: switching between them swaps
	// in place with no motion, while opening or closing either one still animates.
	const [setupSwappedIn, setSetupSwappedIn] = useState(false);
	const [sourceSwappedIn, setSourceSwappedIn] = useState(false);
	const panelsOpenRef = useRef({ setup: false, source: false });
	panelsOpenRef.current = { setup: isDeviceSettingsOpen, source: isSourcePanelOpen };
	const showSetup = isDeviceSettingsOpen || (setupPresence.present && !isSourcePanelOpen);
	const showSource = isSourcePanelOpen || (sourcePresence.present && !isDeviceSettingsOpen);
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
		setPermissionPanelOpen(false);
		pendingPermissionActionRef.current = null;
		recordAfterSourceSelectionRef.current = false;
	}, []);

	// The grip remounts when the pill folds or unfolds; a keyboard toggle keeps focus on it.
	const refocusGripRef = useRef(false);
	const transferringGripFocusRef = useRef(false);
	const toggleHudMinimized = useCallback(
		(fromKeyboard: boolean) => {
			refocusGripRef.current = fromKeyboard;
			closePopovers();
			setHudMinimized((current) => {
				saveUserPreferences({ hudMinimized: !current });
				return !current;
			});
		},
		[closePopovers],
	);

	useEffect(() => {
		let restoring = loadUserPreferences().hudDock;
		const off = window.electronAPI?.onHudDockChanged?.((side) => {
			// Panels close as the pill tucks in; one that opens later brings it back out.
			if (side) closePopovers();
			setTuckingTop(false);
			setDockInstant(side !== null && side === restoring);
			restoring = null;
			setHudDock(side);
			saveUserPreferences({ hudDock: side });
		});
		if (restoring) window.electronAPI?.setHudDock?.(restoring);
		return off;
	}, [closePopovers]);

	const tuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (tuckTimerRef.current) clearTimeout(tuckTimerRef.current);
		},
		[],
	);
	const tuckToTop = useCallback(() => {
		closePopovers();
		setTuckingTop(true);
		if (tuckTimerRef.current) clearTimeout(tuckTimerRef.current);
		tuckTimerRef.current = setTimeout(
			() => window.electronAPI?.setHudDock?.("top"),
			HUD_TUCK_SLIDE_MS,
		);
	}, [closePopovers]);

	const toggleDock = useCallback(
		(fromKeyboard: boolean) => {
			refocusGripRef.current = fromKeyboard;
			togglePinned();
		},
		[togglePinned],
	);

	const openPermissionPanel = useCallback(
		(permissions: CapturePermissions, then: (() => void) | null) => {
			pendingPermissionActionRef.current = then;
			setCapturePermissions(permissions);
			setIsDeviceSettingsOpen(false);
			setIsSourcePanelOpen(false);
			setIsPeekOpen(false);
			setPermissionPanelOpen(true);
		},
		[],
	);

	// Kept current without a round trip, so Record starts in the same click.
	const knownPermissionsRef = useRef<CapturePermissions | null>(null);
	useEffect(() => {
		const refresh = () => {
			void readCapturePermissions().then((next) => {
				if (next) knownPermissionsRef.current = next;
			});
		};
		refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, []);

	/** Runs `action` at once when capture is allowed; otherwise explains first and runs it once it is. */
	const runWithCapturePermissions = useCallback(
		(action: () => void) => {
			const permissions = knownPermissionsRef.current;
			if (
				!permissions ||
				permissionStep(permissions, permissionNeedsRef.current).kind === "ready"
			) {
				action();
				return;
			}
			openPermissionPanel(permissions, action);
		},
		[openPermissionPanel],
	);

	const settlePermissions = useCallback((permissions: CapturePermissions) => {
		knownPermissionsRef.current = permissions;
		setCapturePermissions(permissions);
		if (permissionStep(permissions, permissionNeedsRef.current).kind !== "ready") return;
		setPermissionPanelOpen(false);
		const action = pendingPermissionActionRef.current;
		pendingPermissionActionRef.current = null;
		action?.();
	}, []);

	// System Settings changes arrive without an event, so the open panel polls.
	useEffect(() => {
		if (!permissionPanelOpen) return;
		let cancelled = false;
		const timer = window.setInterval(() => {
			void readCapturePermissions().then((next) => {
				if (!cancelled && next) settlePermissions(next);
			});
		}, 1000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [permissionPanelOpen, settlePermissions]);

	const closePermissionPanel = useCallback(() => {
		setPermissionPanelOpen(false);
		pendingPermissionActionRef.current = null;
	}, []);

	const requestNextPermission = useCallback(async () => {
		if (!capturePermissions) return;
		const step = permissionStep(capturePermissions, permissionNeedsRef.current);
		if (step.kind !== "ask") return;
		const api = window.electronAPI;
		setPermissionRequestBusy(true);
		try {
			if (step.permission === "screen") await api.requestScreenAccess();
			else if (step.permission === "microphone") await api.requestMicrophoneAccess?.();
			else await api.requestCameraAccess();
		} catch (error) {
			console.warn("Permission request failed:", error);
		} finally {
			setPermissionRequestBusy(false);
		}
		const next = await readCapturePermissions();
		if (next) settlePermissions(next);
	}, [capturePermissions, settlePermissions]);

	const openPrivacySettings = useCallback((kind: CapturePermissionKind) => {
		void window.electronAPI?.openPrivacySettings?.(kind);
	}, []);

	const relaunchApp = useCallback(() => {
		void window.electronAPI?.relaunchApp?.();
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

		// Clicks outside the painted panel now reach the app underneath, so a
		// click elsewhere shows up here as the HUD losing focus. The permission
		// panel stays: its steps send the user to System Settings and back.
		const handleBlur = () => {
			setIsDeviceSettingsOpen(false);
			setIsPeekOpen(false);
			setIsSourcePanelOpen(false);
		};

		window.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleEscape);
		window.addEventListener("blur", handleBlur);

		return () => {
			window.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleEscape);
			window.removeEventListener("blur", handleBlur);
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
	const reportedPillSizeRef = useRef({ width: 0, height: 0, offsetX: 0, offsetY: 0 });
	const dockTabRef = useRef<HTMLDivElement | null>(null);
	const tuckBumpRef = useRef<HTMLDivElement | null>(null);
	const isDraggingHudRef = useRef(false);

	const horizontalHudWidth = Math.min(HUD_PILL_WIDTH, getAvailableScreenWidth() - 32);

	useLayoutEffect(() => {
		const anchor = hudAnchorRef.current;
		if (!anchor) return;
		anchor.style.setProperty("--hud-popover-gap", `${HUD_POPOVER_GAP}px`);
		anchor.style.setProperty("--hud-stack-gap", `${HUD_STACK_GAP}px`);
		anchor.style.setProperty("--hud-horizontal-width", `${horizontalHudWidth}px`);
		anchor.style.setProperty(
			"--hud-bar-max-h",
			`${computeHudBarMaxHeight(getAvailableScreenHeight())}px`,
		);
	}, [horizontalHudWidth]);

	// Height caps for the floating surfaces when the pill rests at a screen edge.
	// The window always reserves these on both sides of the bar; the CSS caps are
	// then shrunk to the room on whichever side the stack opens.
	const stackCapsRef = useRef({ popover: 0, modal: 0 });
	// The pill's display, from main. The window can reach onto a neighbour, where
	// window.screen would describe the wrong display; that is only the fallback.
	const workAreaRef = useRef<{ top: number; height: number } | null>(null);
	const [stackPlacement, setStackPlacement] = useState<HudStackPlacement>("above");

	const updateHudPlacement = useCallback(() => {
		const barEl = hudBarRef.current;
		const anchorEl = hudAnchorRef.current;
		const caps = stackCapsRef.current;
		if (!barEl || !anchorEl || caps.modal <= 0) return;
		const barRect = barEl.getBoundingClientRect();
		// Not laid out yet, or no real display to measure against: keep the default side.
		if (barRect.height <= 0 || !(window.screen?.availHeight > 0)) return;
		const pillTop = window.screenY + barRect.top;
		const area = workAreaRef.current ?? {
			top: getAvailableScreenTop(),
			height: getAvailableScreenHeight(),
		};
		const { placement, room } = computeHudPlacement({
			pillTop,
			pillBottom: pillTop + barRect.height,
			areaTop: area.top,
			areaBottom: area.top + area.height,
			stackHeight: caps.modal,
		});
		anchorEl.style.setProperty(
			"--hud-popover-max-h",
			`${fitHudStackCap(caps.popover, room, HUD_POPOVER_MIN_HEIGHT)}px`,
		);
		anchorEl.style.setProperty(
			"--hud-modal-max-h",
			`${fitHudStackCap(caps.modal, room, HUD_POPOVER_MIN_HEIGHT)}px`,
		);
		setStackPlacement(placement);
	}, []);

	useEffect(
		() =>
			window.electronAPI?.onHudWorkAreaChanged?.((area) => {
				workAreaRef.current = { top: area.y, height: area.height };
				updateHudPlacement();
			}),
		[updateHudPlacement],
	);

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
		// mean the window grows when the panel opens, and the renderer repaints a
		// frame or two after the native resize lands. That gap is visible as
		// exactly the position judder this whole architecture exists to remove.
		// So: reserve the maximum, always.
		const popoverMaxHeight = computeHudPopoverMaxHeight(barHeight, availableHeight);
		const modalMaxHeight = computeHudModalMaxHeight(barHeight, availableHeight);
		stackCapsRef.current = { popover: popoverMaxHeight, modal: modalMaxHeight };
		updateHudPlacement();

		const { required, granted } = computeHudWindowSize({
			barWidth,
			barHeight,
			noticeHeight,
			stackMaxHeight: Math.max(popoverMaxHeight, modalMaxHeight),
		});

		// The painted pill is what drags and resizes keep on screen, so main hears
		// about it whenever it changes, even when the window itself does not. While
		// tucked, that is the tab. Positions come from layout, not paint: the pill and
		// the tab slide in and out of their edge on a transform.
		const tabEl =
			dockedSideRef.current && dockedSideRef.current !== "top" ? dockTabRef.current : null;
		const anchorRect = hudAnchorRef.current?.getBoundingClientRect();
		const pillEl = tabEl ?? barEl;
		const pillWidth = tabEl ? tabEl.offsetWidth : Math.round(barRect.width || HUD_PILL_WIDTH);
		if (dockTabRef.current && dockedSideRef.current) {
			const tabWidth = dockTabRef.current.offsetWidth;
			const barWidth = barRect.width || HUD_PILL_WIDTH;
			hudAnchorRef.current?.style.setProperty(
				"--hud-dock-cap-offset",
				`${(barWidth - tabWidth) / 2}px`,
			);
			hudAnchorRef.current?.style.setProperty(
				"--hud-dock-center-scale",
				`${(tabWidth - 40) / (barWidth - 50)}`,
			);
		}
		// The tuck bump above the pill counts as pill, so it is never pushed off screen.
		const pillTopOffset = Math.min(
			pillEl.offsetTop,
			tabEl ? pillEl.offsetTop : (tuckBumpRef.current?.offsetTop ?? pillEl.offsetTop),
		);
		const pillHeight = tabEl
			? tabEl.offsetHeight
			: Math.round(barHeight) + pillEl.offsetTop - pillTopOffset;
		const pillLeft = (anchorRect?.left ?? 0) + pillEl.offsetLeft;
		const pillTop = (anchorRect?.top ?? 0) + pillTopOffset;
		const pillOffsetX = Math.round(pillLeft + pillWidth / 2 - window.innerWidth / 2);
		const pillOffsetY = Math.round(pillTop + pillHeight / 2 - window.innerHeight / 2);
		const reportedPill = reportedPillSizeRef.current;
		if (
			reportedPill.width !== pillWidth ||
			reportedPill.height !== pillHeight ||
			reportedPill.offsetX !== pillOffsetX ||
			reportedPill.offsetY !== pillOffsetY
		) {
			reportedPillSizeRef.current = {
				width: pillWidth,
				height: pillHeight,
				offsetX: pillOffsetX,
				offsetY: pillOffsetY,
			};
			window.electronAPI.setHudPillSize?.(pillWidth, pillHeight, pillOffsetX, pillOffsetY);
		}

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
	}, [horizontalHudWidth, reportDirectionExclusionRectangles, updateHudPlacement]);

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
	const setDockTabEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, dockTabRef),
		[observeHudElement],
	);
	// Main hears about the tab, or the pill again, the moment it tucks in or comes out.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measures on each tuck and untuck
	useLayoutEffect(() => measureHudSize(), [dockedSide, measureHudSize]);
	const setHudNoticesEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, hudNoticesRef),
		[observeHudElement],
	);
	const setPopoverEl = useCallback((el: HTMLDivElement | null) => {
		popoverRef.current = el;
	}, []);
	const panelFocusOriginRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (isDeviceSettingsOpen || isSourcePanelOpen) {
			if (!panelFocusOriginRef.current && document.activeElement instanceof HTMLElement) {
				panelFocusOriginRef.current = document.activeElement;
			}
			const frame = requestAnimationFrame(() => {
				const panel = popoverRef.current;
				const target =
					panel?.querySelector<HTMLElement>("[role='tab'][tabindex='0']") ??
					panel?.querySelector<HTMLElement>("button:not(:disabled), [tabindex='0']");
				target?.focus({ preventScroll: true });
			});
			return () => cancelAnimationFrame(frame);
		}
		const origin = panelFocusOriginRef.current;
		panelFocusOriginRef.current = null;
		if (
			origin?.isConnected &&
			document.hasFocus() &&
			(document.activeElement === document.body ||
				hudAnchorRef.current?.contains(document.activeElement))
		) {
			origin.focus({ preventScroll: true });
		}
	}, [isDeviceSettingsOpen, isSourcePanelOpen]);

	const hudIgnoreMouseEventsRef = useRef<boolean | undefined>(undefined);
	const setHudMouseEventsEnabled = useCallback(
		(enabled: boolean, force = false) => {
			const shouldIgnoreMouseEvents = !enabled && !isLinuxHud;
			if (!force && hudIgnoreMouseEventsRef.current === shouldIgnoreMouseEvents) {
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

	// The overlay takes the mouse only over painted surfaces, open panel or not.
	// Its transparent area can cover a large part of the screen, and holding it
	// interactive while a panel was open swallowed clicks and scrolling meant for
	// other apps, such as System Settings during the permission steps. Pointer
	// movement is still forwarded while click-through, so a pointer crossing from
	// the pill to a panel turns input back on before it can click.
	// A surface that opens or closes under a still pointer gets no pointermove, so
	// check where the pointer was.
	const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-checks the pointer whenever a panel opens or closes
	useEffect(() => {
		const point = lastPointerRef.current;
		const underPointer = point ? document.elementFromPoint?.(point.x, point.y) : null;
		setHudMouseEventsEnabled(isPaintedHudSurface(underPointer));
	}, [isPopoverOpen, setHudMouseEventsEnabled]);

	const defaultSourceName = t("sourceSelector.defaultSourceName");
	const [selectedSource, setSelectedSource] = useState(defaultSourceName);
	const [hasSelectedSource, setHasSelectedSource] = useState(false);
	const [selectedSourceKind, setSelectedSourceKind] = useState<"display" | "window">("display");
	const localizedSourceLabel = hasSelectedSource ? selectedSource : defaultSourceName;
	const sourceChipIntent = useCallback(() => {
		prefetchPickerSources();
	}, []);
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
			// Setup stays up while macOS answers, then the picker replaces it in place.
			const fromSetup = panelsOpenRef.current.setup;
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
				// Asking macOS directly would show its prompt with no explanation.
				const permissions = await readCapturePermissions();
				if (permissions) knownPermissionsRef.current = permissions;
				if (permissions && permissions.screen !== "granted") {
					openPermissionPanel(permissions, null);
					return { opened: false, reason: "permission-required" };
				}
				const access = await window.electronAPI.requestScreenAccess?.().catch(() => null);
				// Capture may have started while macOS answered; the source is fixed then.
				if (controlsLockedRef.current) {
					return { opened: false, reason: "controls-locked" };
				}
				if (access?.granted) {
					setSourceSwappedIn(fromSetup);
					setIsDeviceSettingsOpen(false);
					setIsPeekOpen(false);
					setSourcePanelKind(kind);
					setIsSourcePanelOpen(true);
					return { opened: true };
				}
			}
			if (window.electronAPI) {
				setIsDeviceSettingsOpen(false);
				return await openSourceSelectorWithPermissionRetry({
					openSourceSelector: () => window.electronAPI.openSourceSelector(),
					requestScreenAccess: () => window.electronAPI.requestScreenAccess(),
				});
			}

			return { opened: false, reason: "electron-api-unavailable" };
		},
		[openPermissionPanel, portalOwnsSource],
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

			if (!recording) {
				runWithCapturePermissions(toggleRecording);
				return;
			}
			toggleRecording();
		},
		[
			hasSelectedSource,
			portalOwnsSource,
			openSourceSelector,
			recording,
			runWithCapturePermissions,
			saving,
			toggleRecording,
		],
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
			if (event.key !== "Backspace" || !canRemovePreviousClip || peekOpen || isDeviceSettingsOpen)
				return;
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
		return window.electronAPI?.onHudStartRecording?.(() => {
			if (recording || starting || saving) return;
			handleRecordButtonClick();
		});
	}, [handleRecordButtonClick, recording, saving, starting]);

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
	const openTranscript = useCallback(() => {
		if (!saving) void window.electronAPI.openTranscript?.();
	}, [saving]);
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

	const toggleCursorMode = useCallback(async () => {
		if (controlsLocked) return;
		const mode = cursorCaptureMode === "editable-overlay" ? "system" : "editable-overlay";
		if (isLinuxHud && recording && paused) {
			const result = await selectRecordingSource(mode);
			if (!result.success) {
				if (!result.cancelled)
					toast.error(t("sourceSelector.selectFailed"), { description: result.error });
				return;
			}
		}
		setCursorCaptureMode(mode);
		void window.electronAPI?.setRecordingPrefs?.({ cursorCaptureMode: mode });
	}, [
		controlsLocked,
		cursorCaptureMode,
		isLinuxHud,
		recording,
		paused,
		selectRecordingSource,
		setCursorCaptureMode,
		t,
	]);

	// The monitor window reads the same preference and hides itself on the
	// storage event; the camera keeps recording either way.
	const [cameraMonitorHidden, setCameraMonitorHidden] = useState(
		() => loadUserPreferences().cameraMonitorHidden,
	);
	useEffect(() => {
		const readHidden = () => setCameraMonitorHidden(loadUserPreferences().cameraMonitorHidden);
		window.addEventListener("storage", readHidden);
		return () => window.removeEventListener("storage", readHidden);
	}, []);
	const toggleCameraMonitor = useCallback(() => {
		setCameraMonitorHidden((current) => {
			saveUserPreferences({ cameraMonitorHidden: !current });
			return !current;
		});
	}, []);

	const toggleMicrophone = useCallback(() => {
		if (controlsLocked) return;
		const enabled = !microphoneEnabled;
		setMicrophoneEnabled(enabled);
		void window.electronAPI?.setRecordingPrefs?.({ micEnabled: enabled });
	}, [controlsLocked, microphoneEnabled, setMicrophoneEnabled]);

	const [cameraHandoff, setCameraHandoff] = useState(false);
	const toggleWebcam = useCallback(() => {
		if (controlsLocked) return;
		const enabled = !webcamEnabled;
		// If the settings panel owns a temporary verification stream, stop it before
		// the recorder acquires the same device. flushSync runs that cleanup now, so
		// the panel can stay open while the switch is toggled.
		if (enabled) flushSync(() => setCameraHandoff(true));
		void setWebcamEnabled(enabled)
			.then((applied) => {
				if (applied) void window.electronAPI?.setRecordingPrefs?.({ camEnabled: enabled });
			})
			.finally(() => {
				if (enabled) setCameraHandoff(false);
			});
	}, [controlsLocked, setWebcamEnabled, webcamEnabled]);

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
		setSetupSwappedIn(panelsOpenRef.current.source);
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
			void setLocale(nextLocale as Parameters<typeof setLocale>[0]).then((result) => {
				if (result === "applied") resolveSystemLocaleSuggestion();
				else if (result === "failed") toast.error(t("languageLoadFailed"));
			});
		},
		[resolveSystemLocaleSuggestion, setLocale, t],
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
			setHudDragging(true);
			window.electronAPI?.beginHudOverlayDrag?.();
		},
		[setHudMouseEventsEnabled],
	);

	const endHudDrag = useCallback(() => {
		if (!dragOriginRef.current) return;
		dragOriginRef.current = null;
		isDraggingHudRef.current = false;
		setHudDragging(false);
		window.electronAPI?.endHudOverlayDrag?.();
		measureHudSize();
		// The renderer learns its new screen position a moment after the last
		// move lands, so the stack picks its side once that has caught up.
		window.setTimeout(updateHudPlacement, 120);
	}, [measureHudSize, updateHudPlacement]);

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
	const gripKey = `${pillRecording}:${dockedSide}`;
	const gripRecordingRef = useRef(gripKey);
	useEffect(() => {
		if (gripRecordingRef.current === gripKey) return;
		gripRecordingRef.current = gripKey;
		endHudDrag();
	}, [gripKey, endHudDrag]);

	const reconcilePointer = useCallback(
		(point: { x: number; y: number } | null, fallback: Element | null = null, force = false) => {
			if (isDraggingHudRef.current) return;
			lastPointerRef.current = point;
			const target = point ? (document.elementFromPoint?.(point.x, point.y) ?? fallback) : null;
			const inside = isPaintedHudSurface(target);
			samplePointer(inside);
			setHudMouseEventsEnabled(inside, force);
		},
		[samplePointer, setHudMouseEventsEnabled],
	);
	const handleRootPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			reconcilePointer(
				{ x: event.clientX, y: event.clientY },
				event.target instanceof Element ? event.target : null,
			);
		},
		[reconcilePointer],
	);
	const nativePointerActiveRef = useRef(false);
	useEffect(() => {
		const off = window.electronAPI?.onHudPointerCheck?.((point) =>
			reconcilePointer(point, null, true),
		);
		nativePointerActiveRef.current = typeof off === "function";
		return () => {
			nativePointerActiveRef.current = false;
			off?.();
		};
	}, [reconcilePointer]);
	const handlePointerLeave = useCallback(() => {
		if (!nativePointerActiveRef.current || isLinuxHud) reconcilePointer(null);
		else setHudMouseEventsEnabled(false);
	}, [isLinuxHud, reconcilePointer, setHudMouseEventsEnabled]);
	const handleSurfacePointerEnter = useCallback(() => {
		enableHudMouseEvents();
		samplePointer(true);
	}, [enableHudMouseEvents, samplePointer]);

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
			cameraMonitor: t("deviceSettings.cameraMonitor"),
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
			volume: t("peek.volume"),
			seek: t("peek.seek"),
			playbackError: t("peek.playbackError"),
			retry: t("peek.retry"),
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
				<>
					<button
						type="button"
						className={styles.hudSetupFooterButton}
						disabled={saving}
						onClick={openNotes}
					>
						<NotepadText size={15} aria-hidden />
						{t("setup.notes")}
					</button>
					<button
						type="button"
						className={styles.hudSetupFooterButton}
						disabled={saving}
						onClick={openTranscript}
						data-testid="hud-open-transcript"
					>
						<Captions size={15} aria-hidden />
						{t("setup.transcript")}
					</button>
				</>
			),
		[isLinuxHud, openNotes, openTranscript, saving, t],
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

	const choosePausedSource = useCallback(async () => {
		const result = await selectRecordingSource();
		if (!result.success && !result.cancelled)
			toast.error(t("sourceSelector.selectFailed"), { description: result.error });
	}, [selectRecordingSource, t]);

	const setupExtras = useMemo<HudSetupExtras>(
		() => ({
			sourceLabel: portalOwnsSource ? undefined : localizedSourceLabel,
			sourceKind: selectedSourceKind,
			sourceDisabled: controlsLocked,
			onChooseSource: portalOwnsSource && recording ? () => void choosePausedSource() : undefined,
			onSelectDisplay: portalOwnsSource ? undefined : () => void selectDisplaySource(),
			onOpenSource: portalOwnsSource ? undefined : () => void openSourceSelector("windows"),
			editableCursor: cursorCaptureMode === "editable-overlay",
			onToggleCursor: supportsCursorModeToggle ? toggleCursorMode : undefined,
			cameraMonitorHidden,
			onToggleCameraMonitor: toggleCameraMonitor,
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
			cameraMonitorHidden,
			controlsLocked,
			cursorCaptureMode,
			handleSelectLocale,
			locale,
			openSourceSelector,
			portalOwnsSource,
			choosePausedSource,
			localizedSourceLabel,
			sendHudOverlayHide,
			setupFooter,
			supportsCursorModeToggle,
			toggleCameraMonitor,
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: transfer keyboard focus when the visible grip changes
	useEffect(() => {
		if (!refocusGripRef.current) return;
		refocusGripRef.current = false;
		const container = tuckedSide && tuckedSide !== "top" ? dockTabRef.current : hudBarRef.current;
		transferringGripFocusRef.current = true;
		container?.querySelector<HTMLElement>("[data-testid='hud-drag-handle']")?.focus();
		transferringGripFocusRef.current = false;
	}, [pillMinimized, dockedSide, tuckedSide, dockPinned]);

	const stackVisible =
		isPopoverOpen ||
		showSetup ||
		showSource ||
		permissionPresence.present ||
		canPeek ||
		hasNotices ||
		Boolean(shownRemovedClip);
	// Hidden while the pill is tucked or a panel stands where it sits.
	const tuckBumpHidden =
		Boolean(dockedSide || tuckedSide) ||
		(stackVisible &&
			stackPlacement === "above" &&
			(showSetup ||
				showSource ||
				permissionPresence.present ||
				peekOpen ||
				hasNotices ||
				Boolean(shownRemovedClip)));
	// Pick the stack's side before the first frame it is visible in, while the
	// window is still: a pill near the top opens its panels below it.
	useLayoutEffect(() => {
		if (stackVisible) updateHudPlacement();
	}, [stackVisible, updateHudPlacement]);
	const permissionLabels = useMemo<HudPermissionLabels>(
		() => ({
			title: t("permissions.title"),
			description: t("permissions.description"),
			names: {
				screen: t("permissions.screen"),
				microphone: t("permissions.microphone"),
				camera: t("permissions.camera"),
			},
			details: {
				screen: t("permissions.screenDetail"),
				microphone: t("permissions.microphoneDetail"),
				camera: t("permissions.cameraDetail"),
			},
			granted: t("permissions.granted"),
			notAsked: t("permissions.notAsked"),
			blocked: t("permissions.blocked"),
			continue: t("permissions.continue"),
			openSettings: t("permissions.openSettings"),
			notNow: t("permissions.notNow"),
			relaunch: t("permissions.relaunch"),
			relaunchHint: t("permissions.relaunchHint"),
			settingsHint: t("permissions.settingsHint"),
		}),
		[t],
	);
	const previousClip = [...recordedClips].reverse().find((clip) => !clip.removed) ?? null;
	const removePreviousLabel = t("recording.removePreviousClip");
	const removePreviousTooltip = previousClip
		? t("recording.removePreviousClipWithDuration", {
				duration: formatClipDuration(previousClip.durationMs),
			})
		: removePreviousLabel;

	// One Record control for the full and the minimized idle pill, so both start
	// a recording through exactly the same path.
	const recordButton = (
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
	);

	const topDock = dockedSide === "top";
	const dockGripLabel = dockPinned
		? t("tooltips.collapseDock")
		: dockPeek
			? t("tooltips.pinDock")
			: t("tooltips.openDock");
	const setWingInert = (element: HTMLDivElement | null) => {
		if (element) element.inert = topDock && Boolean(tuckedSide);
	};
	const sourceControl = portalOwnsSource ? (
		<span className="flex-1" />
	) : (
		<HudSourceChip
			label={localizedSourceLabel}
			kind={selectedSourceKind}
			expanded={isSourcePanelOpen}
			disabled={controlsLocked}
			onClick={toggleSourcePanel}
			onIntent={isLinuxHud ? undefined : sourceChipIntent}
		/>
	);
	const audioControl = (
		<HudSystemAudioButton
			enabled={systemAudioEnabled}
			disabled={controlsLocked}
			label={systemAudioEnabled ? t("audio.disableSystemAudio") : t("audio.enableSystemAudio")}
			onClick={toggleSystemAudio}
		/>
	);
	const settingsControl = (
		<HudSettingsButton
			disabled={starting || saving}
			expanded={isDeviceSettingsOpen}
			label={t("deviceSettings.title")}
			onClick={toggleDeviceSettings}
		/>
	);
	const removeControl = (
		<HudRemovePreviousClipButton
			disabled={saving || clipFinalizing || !canRemovePreviousClip}
			label={removePreviousLabel}
			tooltip={removePreviousTooltip}
			onClick={handleRemovePreviousClip}
		/>
	);
	const replayControl = (
		<HudExpandButton
			expanded={peekOpen}
			disabled={!canPeek}
			label={t("peek.open")}
			onClick={togglePeek}
		/>
	);
	const stopControl = (
		<HudStopButton
			saving={saving}
			disabled={saving || clipFinalizing}
			label={recordingHudActive ? t("tooltips.stopRecording") : t("tooltips.cancelRecording")}
			savingLabel={t("recording.saving")}
			onClick={handleRecordClick}
		/>
	);

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
			<Toaster
				position={stackPlacement === "below" ? "top-center" : "bottom-center"}
				offset={HUD_TOAST_OFFSET}
				duration={6000}
			/>
			{/* The pill's left end sits where the idle pill's does, so folding, unfolding
			    and Record never move the grip out from under the pointer. Whatever floats
			    beside it stacks above it, or below it when the pill is near the top of the display.
			    Everything is laid out by flexbox relative to the pill, so no popover
			    needs a measured position and none of them can move the window. */}
			<div
				ref={hudAnchorRef}
				className={styles.hudAnchor}
				onFocusCapture={() => {
					if (!transferringGripFocusRef.current) setFocusWithin(true);
				}}
				onBlurCapture={(event) => {
					if (
						!(event.relatedTarget instanceof Node) ||
						!event.currentTarget.contains(event.relatedTarget)
					) {
						setFocusWithin(false);
					}
				}}
				onKeyDown={(event) => {
					if (event.key !== "Escape" || !dockedSide || isPopoverOpen) return;
					event.preventDefault();
					event.stopPropagation();
					refocusGripRef.current = true;
					collapseDock();
				}}
				onPointerEnter={handleSurfacePointerEnter}
				onMouseLeave={handlePointerLeave}
				data-placement={stackPlacement}
				data-top-edge={tuckedSide === "top" || shownDockSide === "top" || undefined}
			>
				<div
					ref={setHudBarEl}
					data-hud-interactive="true"
					data-recording-layout={pillRecording ? "recording" : "idle"}
					data-minimized={pillMinimized}
					data-tucked={tuckedSide ?? undefined}
					data-docked={dockedSide ?? undefined}
					data-pinned={dockPinned || undefined}
					data-instant={dockInstant || undefined}
					data-bump-cut={(canMinimize && (tuckedSide || !tuckBumpHidden)) || undefined}
					data-starting={starting && !recordingHudActive}
					className={`${styles.hudBar} ${
						pillRecording
							? styles.hudPillRecording
							: pillMinimized
								? styles.hudPillMinimized
								: styles.hudPillIdle
					}`}
					onPointerEnter={handleSurfacePointerEnter}
					onPointerDown={enableHudMouseEvents}
					onMouseEnter={enableHudMouseEvents}
				>
					{dockedSide === "top" ? (
						<div
							className={styles.hudDockSurface}
							data-testid="hud-dock-surface"
							onPointerMove={handleRootPointerMove}
							aria-hidden
						>
							<span />
							<span />
							<span />
						</div>
					) : null}
					{pillRecording ? (
						<div key="recording" className={`${styles.hudPillRow} ${styles.hudContentEnter}`}>
							<div className={styles.hudDockWing} ref={setWingInert}>
								<HudCompactPauseButton
									paused={presentation.paused}
									busy={clipFinalizing}
									disabled={saving || clipFinalizing || !canPauseRecording}
									label={
										presentation.paused
											? t("tooltips.resumeRecording")
											: t("tooltips.pauseRecording")
									}
									onClick={togglePaused}
								/>
								{topDock ? (
									<>
										{removeControl}
										{replayControl}
									</>
								) : null}
							</div>
							<HudDragHandle
								{...dragHandleProps}
								label={dockedSide ? dockGripLabel : undefined}
								onTap={dockedSide ? toggleDock : undefined}
								tapExpanded={dockedSide ? dockPeek : undefined}
							>
								<HudCompactTimer
									elapsedSeconds={presentation.elapsedSeconds}
									paused={presentation.paused || saving || !recordingHudActive}
								/>
							</HudDragHandle>
							<div className={styles.hudDockWing} ref={setWingInert}>
								{topDock ? (
									<>
										{settingsControl}
										{stopControl}
									</>
								) : (
									<>
										{stopControl}
										{removeControl}
										{replayControl}
										{settingsControl}
									</>
								)}
							</div>
						</div>
					) : pillMinimized ? (
						<div key="minimized" className={`${styles.hudPillRow} ${styles.hudContentEnter}`}>
							<HudDragHandle
								{...dragHandleProps}
								label={dockedSide ? dockGripLabel : t("tooltips.expandHud")}
								onTap={dockedSide ? toggleDock : toggleHudMinimized}
								tapExpanded={dockedSide ? dockPeek : false}
								roomy
							>
								<HudBrandMark />
							</HudDragHandle>
							{recordButton}
						</div>
					) : (
						<div key="idle" className={`${styles.hudPillRow} ${styles.hudContentEnter}`}>
							<div className={styles.hudDockWing} ref={setWingInert}>
								{topDock ? (
									<>
										{sourceControl}
										{audioControl}
									</>
								) : null}
							</div>
							<HudDragHandle
								{...dragHandleProps}
								label={
									dockedSide ? dockGripLabel : canMinimize ? t("tooltips.minimizeHud") : "Klippt"
								}
								onTap={dockedSide ? toggleDock : canMinimize ? toggleHudMinimized : undefined}
								tapExpanded={dockedSide ? dockPeek : true}
							>
								<HudBrandMark />
							</HudDragHandle>
							<div className={styles.hudDockWing} ref={setWingInert}>
								{!topDock ? (
									<>
										{sourceControl}
										{audioControl}
									</>
								) : null}
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
								{settingsControl}
								{recordButton}
							</div>
						</div>
					)}
				</div>

				{canMinimize ? (
					<div
						ref={tuckBumpRef}
						data-testid="hud-tuck-bump"
						data-hidden={(!tuckedSide && tuckBumpHidden) || undefined}
						data-tucked={tuckedSide ?? undefined}
						data-instant={dockInstant || undefined}
						data-narrow={pillMinimized || undefined}
						className={styles.hudTuckRail}
					>
						<div className={styles.hudTuckBump}>
							<svg className={styles.hudTuckShape} viewBox="0 0 74 16" aria-hidden>
								<path />
								<path />
								<path />
							</svg>
							<HudTuckButton
								label={t("tooltips.tuckHud")}
								hidden={tuckBumpHidden}
								onClick={tuckToTop}
								onMouseEnter={enableHudMouseEvents}
								onMouseLeave={handlePointerLeave}
							/>
						</div>
					</div>
				) : null}

				{shownDockSide ? (
					<div
						ref={setDockTabEl}
						data-hud-interactive="true"
						data-testid="hud-dock-tab"
						data-side={shownDockSide}
						data-recording={pillRecording || undefined}
						aria-hidden={shownDockSide === "top" || undefined}
						data-closing={dockPresence.closing || undefined}
						data-covered={(dockedSide && !tuckedSide) || undefined}
						data-instant={dockInstant || undefined}
						className={styles.hudDockTab}
						onPointerEnter={handleSurfacePointerEnter}
						onPointerDown={enableHudMouseEvents}
						onMouseEnter={enableHudMouseEvents}
					>
						{shownDockSide !== "top" ? (
							<HudDragHandle
								{...dragHandleProps}
								label={dockGripLabel}
								onTap={toggleDock}
								tapExpanded={dockPeek}
								roomy
							>
								<HudDockMark
									side={shownDockSide}
									take={pillRecording ? (presentation.paused ? "paused" : "recording") : null}
									elapsedSeconds={presentation.elapsedSeconds}
								/>
							</HudDragHandle>
						) : null}
					</div>
				) : null}

				{stackVisible && (
					// The first child sits closest to the bar on either side.
					<div className={styles.hudAbove}>
						{showSetup && (
							<HudDeviceSettings
								closing={setupPresence.closing}
								instant={setupSwappedIn}
								micDevices={micDevices}
								cameraDevices={cameraDevices}
								activeMicId={microphoneDeviceId || selectedMicId}
								activeCameraId={webcamDeviceId || selectedCameraId}
								cameraEnabled={webcamEnabled}
								cameraStream={webcamPreviewStream}
								cameraHandoff={cameraHandoff}
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
								cameraLocked={recording}
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

						{showSource && (
							<SourcePicker
								variant="panel"
								instant={sourceSwappedIn}
								initialKind={sourcePanelKind}
								className={styles.hudPanel}
								closing={sourcePresence.closing}
								onClose={closeSourcePanel}
								onChosen={() => setIsSourcePanelOpen(false)}
								panelRef={isSourcePanelOpen ? setPopoverEl : undefined}
							/>
						)}

						{permissionPresence.present && capturePermissions && (
							<HudPermissionPanel
								permissions={capturePermissions}
								needs={permissionNeeds}
								step={permissionStep(capturePermissions, permissionNeeds)}
								labels={permissionLabels}
								busy={permissionRequestBusy}
								closing={permissionPresence.closing}
								panelRef={permissionPanelOpen ? setPopoverEl : undefined}
								onContinue={() => void requestNextPermission()}
								onOpenSettings={openPrivacySettings}
								onRelaunch={relaunchApp}
								onClose={closePermissionPanel}
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

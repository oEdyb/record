import { fixWebmDuration } from "@fix-webm-duration/fix";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { MIC_GAIN_BOOST, mixAudioTracks } from "@/lib/audioMix";
import {
	type NativeLinuxRecordingRequest,
	portalOwnsSourceSelection,
} from "@/lib/nativeLinuxRecording";
import { getKeptRecordingDurationMs } from "@/lib/nativeMacClipSession";
import type { NativeMacRecordingRequest, RecordStartMark } from "@/lib/nativeMacRecording";
import {
	type NativeWindowsRecordingRequest,
	parseWindowHandleFromSourceId,
} from "@/lib/nativeWindowsRecording";
import {
	buildNativeMacRecordingRequest,
	computeCaptureBitrate,
	MIN_FRAME_RATE,
	selectRecorderMimeType,
	TARGET_FRAME_RATE,
	TARGET_HEIGHT,
	TARGET_WIDTH,
} from "@/lib/recording/capturePolicy";
import {
	DEFAULT_RECORDING_QUALITY,
	normalizeRecordingQuality,
	type RecordingQuality,
} from "@/lib/recording/recordingQuality";
import {
	discardWebcamRecorder,
	finalizeWebcamAsset,
	NativeMacWebcamClipLedger,
} from "@/lib/recording/webcamSidecars";
import type {
	CursorCaptureMode,
	RecordedVideoAssetInput,
	RecordingSessionClip,
} from "@/lib/recordingSession";
import { requestCameraAccess } from "@/lib/requestCameraAccess";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import {
	DEFAULT_WEBCAM_FORMAT,
	nativeWebcamConstraints,
	normalizeWebcamFormat,
	preferredWebcamConstraints,
	supportsNativeWebcamMode,
	type WebcamFormat,
	webcamFormatFromSettings,
} from "@/lib/webcamFormats";
import { createRecorderHandle, type RecorderHandle } from "./recorderHandle";

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

const CODEC_ALIGNMENT = 2;

const BITS_PER_MEGABIT = 1_000_000;
const CHROME_MEDIA_SOURCE = "desktop";
const RECORDING_FILE_PREFIX = "recording-";
const VIDEO_FILE_EXTENSION = ".webm";
const WEBCAM_FILE_SUFFIX = "-webcam";

const AUDIO_BITRATE_VOICE = 128_000;
const AUDIO_BITRATE_SYSTEM = 192_000;

const CAMERA_ACQUIRE_RETRY_DELAYS_MS = [250, 750] as const;

function cameraAcquireRetryDelay(error: unknown, retryIndex: number): number | null {
	if (
		!(error instanceof DOMException) ||
		!["NotReadableError", "AbortError", "OverconstrainedError"].includes(error.name)
	) {
		return null;
	}
	return CAMERA_ACQUIRE_RETRY_DELAYS_MS[retryIndex] ?? null;
}

function cameraErrorDescription(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

type UseScreenRecorderReturn = {
	recordingQuality: RecordingQuality;
	setRecordingQuality: (quality: RecordingQuality) => void;
	preferencesReady: boolean;
	recording: boolean;
	starting: boolean;
	paused: boolean;
	saving: boolean;
	clipFinalizing: boolean;
	elapsedSeconds: number;
	activeClipElapsedMs: number;
	recordedClips: RecordingSessionClip[];
	toggleRecording: () => void;
	/** Starts recording with no countdown overlay. Used by the headless CLI runner. */
	startRecordingImmediately: () => Promise<void>;
	togglePaused: () => void;
	canPauseRecording: boolean;
	canReconfigureWhilePaused: boolean;
	canRemovePreviousClip: boolean;
	removePreviousClip: () => Promise<RecordingSessionClip | null>;
	restoreRemovedClip: (clipIndex: number) => Promise<RecordingSessionClip | null>;
	restartRecording: () => void;
	cancelRecording: () => void;
	microphoneEnabled: boolean;
	setMicrophoneEnabled: (enabled: boolean) => void;
	microphoneDeviceId: string | undefined;
	setMicrophoneDeviceId: (deviceId: string | undefined) => void;
	microphoneDeviceName: string | undefined;
	setMicrophoneDeviceName: (deviceName: string | undefined) => void;
	webcamDeviceId: string | undefined;
	setWebcamDeviceId: (deviceId: string | undefined) => void;
	webcamDeviceName: string | undefined;
	setWebcamDeviceName: (deviceName: string | undefined) => void;
	webcamFormat: WebcamFormat;
	setWebcamFormat: (format: WebcamFormat) => void;
	/** High records the sharpest native camera format instead of webcamFormat. */
	webcamFormatAuto: boolean;
	setWebcamFormatAuto: (auto: boolean) => void;
	systemAudioEnabled: boolean;
	setSystemAudioEnabled: (enabled: boolean) => void;
	webcamEnabled: boolean;
	/** Live camera owned by this renderer. Preview-only consumers must not reacquire the device. */
	webcamPreviewStream: MediaStream | null;
	setWebcamEnabled: (enabled: boolean) => Promise<boolean>;
	cursorCaptureMode: CursorCaptureMode;
	setCursorCaptureMode: (mode: CursorCaptureMode) => void;
	softwareEncoderFallbackNoticeVisible: boolean;
	dismissSoftwareEncoderFallbackNotice: (dontShowAgain?: boolean) => void;
};

type NativeWindowsRecordingHandle = {
	recordingId: number;
	finalizing: boolean;
	paused: boolean;
};

type NativeMacRecordingHandle = {
	recordingId: number;
	finalizing: boolean;
	paused: boolean;
	currentClipIndex: number;
	/**
	 * Offset for the active clip's camera file. Each screen clip gets its own
	 * camera file, so a paused camera/device/quality change cannot mutate an
	 * earlier clip or force one variable-format MediaRecorder file.
	 */
	webcamOffsetMs: number | null;
};

type PendingNativeMacWebcamClip = {
	recordingId: number;
	clipIndex: number;
	recorder: RecorderHandle;
	startedAtMs: number;
	webcamOffsetMs: number | null;
};

type NativeLinuxRecordingHandle = {
	recordingId: number;
	finalizing: boolean;
	paused: boolean;
	/**
	 * As on macOS: the webcam MediaRecorder starts immediately in the renderer,
	 * while the helper has to spawn, negotiate a portal session and WAIT FOR THE
	 * USER to answer a picker before its first frame exists. That last part makes
	 * the gap here unbounded rather than merely a process spawn, so trimming it
	 * matters more than it does on macOS. `null` when no webcam was recorded.
	 */
	webcamOffsetMs: number | null;
};

/**
 * How far AHEAD of the native screen recording the browser-recorded webcam
 * started, in whole milliseconds (negative, since the webcam always starts
 * first). `null` when this session recorded no webcam.
 *
 * WHOLE milliseconds on purpose. Both timestamps come from `performance.now()`,
 * whose resolution is 100 µs, so the raw subtraction is almost never an integer
 * — and this number ends up in `cameraTrack.offsetMs`, which the document schema
 * declares as an int. A fractional value failed validation, the camera link was
 * dropped as if the recording had no camera, and the editor drew the screen
 * video in the camera's place. Rounding loses nothing: one frame at 60 fps is
 * 16.7 ms.
 */
export function webcamOffsetMsFrom(
	webcamRecorder: RecorderHandle | null,
	webcamStartedAtMs: number | null,
	nativeStartedAtMs: number,
): number | null {
	if (!webcamRecorder || webcamStartedAtMs === null) {
		return null;
	}
	return -Math.round(nativeStartedAtMs - webcamStartedAtMs);
}

export function useScreenRecorder(): UseScreenRecorderReturn {
	const t = useScopedT("editor");
	const showCameraBlocked = useCallback(() => {
		const openSettings = window.electronAPI?.openCameraPrivacySettings;
		toast.error(t("recording.cameraBlocked"), {
			id: "camera-blocked",
			action: openSettings
				? { label: t("recording.openCameraSettings"), onClick: () => void openSettings() }
				: undefined,
		});
	}, [t]);
	const [preferencesReady, setPreferencesReady] = useState(false);
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [saving, setSaving] = useState(false);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>(undefined);
	const [microphoneDeviceName, setMicrophoneDeviceName] = useState<string | undefined>(undefined);
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(undefined);
	const [webcamDeviceName, setWebcamDeviceName] = useState<string | undefined>(undefined);
	const [recordingQuality, setRecordingQuality] =
		useState<RecordingQuality>(DEFAULT_RECORDING_QUALITY);
	const [webcamFormat, setWebcamFormat] = useState<WebcamFormat>(DEFAULT_WEBCAM_FORMAT);
	const [webcamFormatAuto, setWebcamFormatAuto] = useState(true);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [webcamEnabled, setWebcamEnabledState] = useState(false);
	const [webcamPreviewStream, setWebcamPreviewStream] = useState<MediaStream | null>(null);
	const [cursorCaptureMode, setCursorCaptureMode] = useState<CursorCaptureMode>("system");
	const [softwareEncoderFallbackNoticeVisible, setSoftwareEncoderFallbackNoticeVisible] =
		useState(false);

	// Seed from the main-process recording-prefs SSOT on mount so the floating
	// HUD always reopens with the user's last recording setup.
	useEffect(() => {
		let cancelled = false;
		void window.electronAPI
			?.getRecordingPrefs?.()
			.then((prefs) => {
				if (cancelled || !prefs) return;
				setMicrophoneEnabled(prefs.micEnabled);
				if (prefs.micDeviceId) setMicrophoneDeviceId(prefs.micDeviceId);
				setWebcamEnabledState(prefs.camEnabled);
				if (prefs.camDeviceId) setWebcamDeviceId(prefs.camDeviceId);
				setWebcamFormat(normalizeWebcamFormat(prefs.camFormat));
				setWebcamFormatAuto(prefs.camFormatAuto !== false);
				setRecordingQuality(normalizeRecordingQuality(prefs.recordingQuality));
				setSystemAudioEnabled(prefs.systemAudioEnabled);
				setCursorCaptureMode(prefs.cursorCaptureMode);
			})
			.catch((err) => {
				// Bare ipcRenderer.invoke — rejects if the main handler throws. Falling
				// back to this hook's own defaults is acceptable; an unhandled rejection
				// on every HUD mount is not.
				console.warn("Failed to seed the recording prefs:", err);
			})
			.finally(() => {
				if (!cancelled) setPreferencesReady(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const screenRecorder = useRef<RecorderHandle | null>(null);
	const webcamRecorder = useRef<RecorderHandle | null>(null);
	const nativeWindowsRecording = useRef<NativeWindowsRecordingHandle | null>(null);
	const nativeMacRecording = useRef<NativeMacRecordingHandle | null>(null);
	const nativeMacWebcamClips = useRef(new NativeMacWebcamClipLedger());
	const pendingNativeMacWebcamClip = useRef<PendingNativeMacWebcamClip | null>(null);
	const nativeLinuxRecording = useRef<NativeLinuxRecordingHandle | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const screenStream = useRef<MediaStream | null>(null);
	const microphoneStream = useRef<MediaStream | null>(null);
	const webcamStream = useRef<MediaStream | null>(null);
	const mixingContext = useRef<AudioContext | null>(null);
	const recordingId = useRef<number>(0);
	const accumulatedDurationMs = useRef(0);
	const segmentStartedAt = useRef<number | null>(null);
	const finalizingRecordingId = useRef<number | null>(null);
	const allowAutoFinalize = useRef(false);
	const discardRecordingId = useRef<number | null>(null);
	const restarting = useRef(false);
	const countdownRunId = useRef(0);
	const startMarks = useRef<RecordStartMark[]>([]);
	const markStart = (stage: string) => {
		startMarks.current.push({ stage, atMs: Date.now() });
	};
	const pendingStartRunId = useRef<number | null>(null);
	const recordingStartPending = useRef(false);
	const [countdownActive, setCountdownActive] = useState(false);
	const [clipFinalizing, setClipFinalizing] = useState(false);
	const [recordedClips, setRecordedClips] = useState<RecordingSessionClip[]>([]);
	const [activeClipElapsedMs, setActiveClipElapsedMs] = useState(0);
	const activeClipStartedAt = useRef<number | null>(null);
	const webcamReady = useRef(false);
	const activeWebcamFormat = useRef<WebcamFormat>(DEFAULT_WEBCAM_FORMAT);
	const webcamAcquireId = useRef(0);
	const canPauseRecording =
		recording &&
		!clipFinalizing &&
		Boolean(
			(nativeWindowsRecording.current && !nativeWindowsRecording.current.finalizing) ||
				(nativeMacRecording.current && !nativeMacRecording.current.finalizing) ||
				(nativeLinuxRecording.current && !nativeLinuxRecording.current.finalizing) ||
				(screenRecorder.current && screenRecorder.current.recorder.state !== "inactive"),
		);
	const canReconfigureWhilePaused = Boolean(
		recording && paused && nativeMacRecording.current && !clipFinalizing && !saving,
	);
	const canRemovePreviousClip = Boolean(
		nativeMacRecording.current && !clipFinalizing && recordedClips.some((clip) => !clip.removed),
	);

	const getRecordingDurationMs = useCallback(() => {
		const segmentDuration =
			segmentStartedAt.current === null ? 0 : Date.now() - segmentStartedAt.current;
		return accumulatedDurationMs.current + segmentDuration;
	}, []);

	const queueNativeMacWebcamClipFinalization = useCallback(
		(
			activeRecording: NativeMacRecordingHandle,
			clip: RecordingSessionClip,
			recorder: RecorderHandle,
			webcamOffsetMs: number,
		) =>
			nativeMacWebcamClips.current.queue({
				recordingId: activeRecording.recordingId,
				clip,
				recorder,
				webcamOffsetMs,
			}),
		[],
	);

	const selectMimeType = () => selectRecorderMimeType(MediaRecorder.isTypeSupported);
	const computeBitrate = computeCaptureBitrate;

	const teardownMedia = useCallback(() => {
		if (stream.current) {
			stream.current.getTracks().forEach((track) => track.stop());
			stream.current = null;
		}
		if (screenStream.current) {
			screenStream.current.getTracks().forEach((track) => track.stop());
			screenStream.current = null;
		}
		if (microphoneStream.current) {
			microphoneStream.current.getTracks().forEach((track) => track.stop());
			microphoneStream.current = null;
		}
		if (mixingContext.current) {
			mixingContext.current.close().catch(() => {
				// Ignore close errors during recorder teardown.
			});
			mixingContext.current = null;
		}
	}, []);

	const stopWebcamPreviewStream = useCallback(() => {
		if (!webcamStream.current) {
			return;
		}

		webcamAcquireId.current++;
		webcamStream.current.getTracks().forEach((track) => {
			track.onended = null;
			track.stop();
		});
		webcamStream.current = null;
		setWebcamPreviewStream(null);
		webcamReady.current = true;
	}, []);

	const setWebcamEnabled = useCallback(
		async (enabled: boolean) => {
			if (!enabled) {
				setWebcamEnabledState(false);
				return true;
			}

			const accessResult = await requestCameraAccess();
			if (!accessResult.success) {
				toast.error(t("recording.failedCameraAccess"));
				return false;
			}

			if (!accessResult.granted) {
				showCameraBlocked();
				return false;
			}

			setWebcamEnabledState(true);
			return true;
		},
		[t, showCameraBlocked],
	);

	useEffect(() => {
		if (!webcamEnabled) return;

		let cancelled = false;
		let acquiredStream: MediaStream | null = null;
		const thisAcquireId = ++webcamAcquireId.current;
		webcamReady.current = false;

		const acquire = async () => {
			try {
				let stream: MediaStream;
				let retryIndex = 0;
				let useDefaultCamera = false;
				for (;;) {
					try {
						stream = await navigator.mediaDevices.getUserMedia({
							audio: false,
							video: {
								...(webcamDeviceId && !useDefaultCamera
									? { deviceId: { exact: webcamDeviceId } }
									: {}),
								...(recordingQuality === "high" && webcamFormatAuto
									? nativeWebcamConstraints(
											supportsNativeWebcamMode(
												navigator.mediaDevices.getSupportedConstraints?.() ?? {},
											),
										)
									: preferredWebcamConstraints(webcamFormat)),
							},
						});
						break;
					} catch (cameraError) {
						if (
							cameraError instanceof DOMException &&
							["NotFoundError", "DevicesNotFoundError"].includes(cameraError.name) &&
							webcamDeviceId &&
							!useDefaultCamera
						) {
							useDefaultCamera = true;
							continue;
						}
						const retryDelay = cameraAcquireRetryDelay(cameraError, retryIndex);
						if (retryDelay === null) throw cameraError;
						retryIndex++;
						await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
						if (cancelled || thisAcquireId !== webcamAcquireId.current) return;
					}
				}

				if (cancelled || thisAcquireId !== webcamAcquireId.current) {
					stream.getTracks().forEach((track) => {
						track.onended = null;
						track.stop();
					});
					return;
				}

				acquiredStream = stream;
				const videoTrack = stream.getVideoTracks()[0];
				if (videoTrack) {
					activeWebcamFormat.current = webcamFormatFromSettings(
						videoTrack.getSettings(),
						webcamFormat,
					);
					if (useDefaultCamera) {
						const replacementDeviceId = videoTrack.getSettings().deviceId;
						setWebcamDeviceId(replacementDeviceId || undefined);
						void window.electronAPI?.setRecordingPrefs?.({
							camDeviceId: replacementDeviceId || null,
						});
					}
				}
				stream.getVideoTracks().forEach((track) => {
					track.onended = () => {
						webcamStream.current = null;
						setWebcamPreviewStream(null);
						if (!restarting.current) {
							setWebcamEnabledState(false);
							void window.electronAPI?.setRecordingPrefs?.({ camEnabled: false });
							toast.error(t("recording.cameraDisconnected"));
						}
					};
				});
				webcamStream.current = stream;
				setWebcamPreviewStream(stream);
				webcamReady.current = true;
			} catch (cameraError) {
				if (!cancelled) {
					console.warn(`Failed to get webcam access: ${cameraErrorDescription(cameraError)}`);
					setWebcamEnabledState(false);
					setWebcamPreviewStream(null);
					void window.electronAPI?.setRecordingPrefs?.({ camEnabled: false });
					const isDeviceError =
						cameraError instanceof DOMException &&
						[
							"NotFoundError",
							"DevicesNotFoundError",
							"OverconstrainedError",
							"NotReadableError",
						].includes(cameraError.name);
					if (isDeviceError) toast.error(t("recording.cameraNotFound"));
					else showCameraBlocked();
					webcamReady.current = true;
				}
			}
		};

		void acquire();

		return () => {
			cancelled = true;
			webcamReady.current = false;
			if (acquiredStream) {
				acquiredStream.getTracks().forEach((track) => {
					track.onended = null;
					track.stop();
				});
				if (webcamStream.current === acquiredStream) {
					webcamStream.current = null;
					setWebcamPreviewStream(null);
				}
			}
		};
	}, [
		webcamEnabled,
		webcamDeviceId,
		webcamFormat,
		webcamFormatAuto,
		recordingQuality,
		t,
		showCameraBlocked,
	]);

	const finalizeRecording = useCallback(
		(
			activeScreenRecorder: RecorderHandle,
			activeWebcamRecorder: RecorderHandle | null,
			duration: number,
			activeRecordingId: number,
		) => {
			if (finalizingRecordingId.current === activeRecordingId) {
				return;
			}
			finalizingRecordingId.current = activeRecordingId;
			// Only show the "Saving…" spinner for genuine saves — not for cancel/restart
			// flows where discardRecordingId has already been set.
			const isDiscarded = discardRecordingId.current === activeRecordingId;
			if (!isDiscarded) {
				setSaving(true);
			}

			if (screenRecorder.current === activeScreenRecorder) {
				screenRecorder.current = null;
			}
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}

			teardownMedia();
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			window.electronAPI?.setRecordingState(false);

			void (async () => {
				// Each disk stream must end up either saved or explicitly discarded.
				// store-recorded-session finalizes the streams included in a successful
				// save; the finally block discards everything else.
				let storeSucceeded = false;
				let webcamIncludedInSave = false;
				try {
					const screenBlob = await activeScreenRecorder.recordedBlobPromise;
					if (discardRecordingId.current === activeRecordingId) {
						window.electronAPI?.discardCursorTelemetry(activeRecordingId);
						return;
					}
					// When streaming succeeded the blob is empty; the data is already on disk.
					if (!activeScreenRecorder.isStreaming() && screenBlob.size === 0) {
						return;
					}

					const screenFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${VIDEO_FILE_EXTENSION}`;
					const webcamFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;

					// Only fix duration / convert to ArrayBuffer for in-memory data;
					// streamed recordings are patched on disk by the main process.
					let screenVideoData: ArrayBuffer = new ArrayBuffer(0);
					if (!activeScreenRecorder.isStreaming() && screenBlob.size > 0) {
						const fixedScreenBlob = await fixWebmDuration(screenBlob, duration);
						screenVideoData = await fixedScreenBlob.arrayBuffer();
					}

					let webcamVideoData: ArrayBuffer | undefined;
					if (activeWebcamRecorder) {
						const webcamBlob = await activeWebcamRecorder.recordedBlobPromise.catch(() => null);
						if (!activeWebcamRecorder.isStreaming() && webcamBlob && webcamBlob.size > 0) {
							const fixedWebcamBlob = await fixWebmDuration(webcamBlob, duration);
							webcamVideoData = await fixedWebcamBlob.arrayBuffer();
						} else if (activeWebcamRecorder.isStreaming()) {
							webcamVideoData = new ArrayBuffer(0);
						}
					}
					webcamIncludedInSave = webcamVideoData !== undefined;

					const result = await window.electronAPI.storeRecordedSession({
						screen: {
							videoData: screenVideoData,
							fileName: screenFileName,
						},
						webcam:
							webcamVideoData !== undefined
								? { videoData: webcamVideoData, fileName: webcamFileName }
								: undefined,
						createdAt: activeRecordingId,
						cursorCaptureMode,
						durationMs: duration,
					});

					if (!result.success) {
						console.error("Failed to store recording session:", result.message);
						return;
					}
					// store-recorded-session has flushed and closed the saved streams.
					storeSucceeded = true;

					if (result.session) {
						await window.electronAPI.setCurrentRecordingSession(result.session);
					} else if (result.path) {
						await window.electronAPI.setCurrentVideoPath(result.path);
					}

					await window.electronAPI.switchToEditor({ compactReview: true });
				} catch (error) {
					console.error("Error saving recording:", error);
				} finally {
					// Discard any recorder whose data wasn't part of a successful save (discarded
					// run, failed save, or a webcam whose disk write failed while the screen still
					// saved) so no stream or partial file is left open or orphaned.
					if (!storeSucceeded) {
						await activeScreenRecorder.discard().catch(() => undefined);
					}
					if (activeWebcamRecorder && !(storeSucceeded && webcamIncludedInSave)) {
						await activeWebcamRecorder.discard().catch(() => undefined);
					}
					if (finalizingRecordingId.current === activeRecordingId) {
						finalizingRecordingId.current = null;
					}
					if (discardRecordingId.current === activeRecordingId) {
						discardRecordingId.current = null;
					}
					setSaving(false);
				}
			})();
		},
		[cursorCaptureMode, teardownMedia],
	);

	const finalizeNativeWindowsRecording = useCallback(async (discard = false) => {
		const activeNativeRecording = nativeWindowsRecording.current;
		if (!activeNativeRecording || activeNativeRecording.finalizing) {
			return false;
		}

		activeNativeRecording.finalizing = true;
		if (!discard) {
			setSaving(true);
		}

		const clearNativeRecordingState = () => {
			nativeWindowsRecording.current = null;
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
		};

		try {
			const result = await window.electronAPI.stopNativeWindowsRecording(discard);
			if (discard || result.discarded) {
				clearNativeRecordingState();
				return true;
			}
			if (!result.success) {
				console.error("Failed to stop native Windows recording:", result.error);
				toast.error(result.error ?? "Failed to stop native Windows recording");
				// Clear anyway. The main process releases its helper handle
				// unconditionally, so holding on here left the two sides
				// disagreeing about whether anything was recording: the HUD kept
				// showing a stop button, and pressing it sent a second stop that
				// came back "Native Windows capture is not running." (issue #252).
				// Reaching here now means the recording really is unreadable -- a failed
				// stop that left a playable fragmented file comes back `success`
				// with a session and takes the editor path below, so this branch no
				// longer decides the fate of a recoverable recording.
				clearNativeRecordingState();
				return true;
			}

			clearNativeRecordingState();
			if (result.session) {
				await window.electronAPI.setCurrentRecordingSession(result.session);
			} else if (result.path) {
				await window.electronAPI.setCurrentVideoPath(result.path);
			}

			await window.electronAPI.switchToEditor({ compactReview: true });
			return true;
		} catch (error) {
			console.error("Error saving native Windows recording:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to save native Windows recording",
			);
			clearNativeRecordingState();
			return true;
		} finally {
			if (discardRecordingId.current === activeNativeRecording.recordingId) {
				discardRecordingId.current = null;
			}
			setSaving(false);
		}
	}, []);

	const finalizeNativeMacRecording = useCallback(
		async (discard = false) => {
			const activeNativeRecording = nativeMacRecording.current;
			if (!activeNativeRecording || activeNativeRecording.finalizing) {
				return false;
			}

			activeNativeRecording.finalizing = true;
			const clickedAtMs = Date.now();
			if (!discard) {
				setSaving(true);
			}
			const activeWebcamRecorder = webcamRecorder.current;
			const pendingWebcamClip = pendingNativeMacWebcamClip.current;
			if (pendingNativeMacWebcamClip.current === pendingWebcamClip) {
				pendingNativeMacWebcamClip.current = null;
			}
			const activeWebcamOffsetMs = activeNativeRecording.webcamOffsetMs ?? 0;
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}
			if (activeWebcamRecorder?.recorder.state !== "inactive") {
				activeWebcamRecorder?.recorder.stop();
			}
			let activeWebcamRecorderQueued = false;
			if (
				pendingWebcamClip?.recordingId === activeNativeRecording.recordingId &&
				pendingWebcamClip.recorder.recorder.state !== "inactive"
			) {
				pendingWebcamClip.recorder.recorder.stop();
			}
			let pendingWebcamRecorderQueued = false;

			const clearNativeRecordingState = () => {
				nativeMacRecording.current = null;
				setRecording(false);
				setPaused(false);
				setElapsedSeconds(0);
				accumulatedDurationMs.current = 0;
				segmentStartedAt.current = null;
				activeClipStartedAt.current = null;
				setActiveClipElapsedMs(0);
				setRecordedClips([]);
				setClipFinalizing(false);
			};

			try {
				const result = await window.electronAPI.stopNativeMacRecording(discard, clickedAtMs);
				window.electronAPI.markStopStage?.("renderer-stop-returned");
				if (discard || result.discarded) {
					clearNativeRecordingState();
					return true;
				}
				if (!result.success) {
					console.error("Failed to stop native macOS recording:", result.error);
					toast.error(result.error ?? "Failed to stop native macOS recording");
					// See the Windows finalizer: the main process has already
					// released its helper handle, so keeping ours leaves the HUD
					// stuck in a recording state the app can never be stopped out
					// of (issue #252).
					clearNativeRecordingState();
					return true;
				}
				if (result.warning) {
					toast.error(`${result.warning} Earlier completed clips were kept.`);
				}

				const sessionClips = result.session?.clips ?? [];
				if (activeWebcamRecorder) {
					const activeClip = sessionClips.find(
						(clip) => clip.index === activeNativeRecording.currentClipIndex,
					);
					if (activeClip) {
						queueNativeMacWebcamClipFinalization(
							activeNativeRecording,
							activeClip,
							activeWebcamRecorder,
							activeWebcamOffsetMs,
						);
						activeWebcamRecorderQueued = true;
					}
				}
				if (pendingWebcamClip?.recordingId === activeNativeRecording.recordingId) {
					const pendingClip = sessionClips.find(
						(clip) => clip.index === pendingWebcamClip.clipIndex,
					);
					if (pendingClip) {
						queueNativeMacWebcamClipFinalization(
							activeNativeRecording,
							pendingClip,
							pendingWebcamClip.recorder,
							pendingWebcamClip.webcamOffsetMs ?? 0,
						);
						pendingWebcamRecorderQueued = true;
					}
				}

				const keptIndexes = new Set(
					sessionClips.filter((clip) => !clip.removed).map((clip) => clip.index),
				);
				const { webcams: webcamInputs, failures: webcamFailures } =
					await nativeMacWebcamClips.current.collectKept(keptIndexes);
				for (const failure of webcamFailures) {
					toast.error(
						`Camera clip ${failure.clipIndex + 1} was not saved (${failure.error}). The screen recording was kept.`,
					);
				}

				if (webcamInputs.length > 0 && result.path) {
					const attachResult = await window.electronAPI.attachNativeMacClipWebcams({
						screenVideoPath: result.path,
						recordingId: activeNativeRecording.recordingId,
						clips: sessionClips,
						webcams: webcamInputs,
					});
					if (attachResult.success) {
						result.session = attachResult.session;
						nativeMacWebcamClips.current.markSaved(webcamInputs);
					} else {
						console.error("Failed to attach native macOS clip cameras:", attachResult.error);
						toast.error(attachResult.error ?? "Failed to store camera clips");
					}
				}

				window.electronAPI.markStopStage?.("webcams-collected");
				clearNativeRecordingState();
				if (result.session) {
					await window.electronAPI.setCurrentRecordingSession(result.session);
				} else if (result.path) {
					await window.electronAPI.setCurrentVideoPath(result.path);
				}
				window.electronAPI.markStopStage?.("session-set");

				await window.electronAPI.switchToEditor({ compactReview: true });
				window.electronAPI.markStopStage?.("editor-switched");
				return true;
			} catch (error) {
				console.error("Error saving native macOS recording:", error);
				toast.error(
					error instanceof Error ? error.message : "Failed to save native macOS recording",
				);
				clearNativeRecordingState();
				return true;
			} finally {
				// A webcam stream that wasn't folded into a saved session has to be closed
				// and its partial file removed, or a discarded or failed capture orphans a
				// half-written .webm now that the bytes go to disk as they arrive.
				const unclaimedWebcamRecorders = new Set<RecorderHandle>();
				if (activeWebcamRecorder && !activeWebcamRecorderQueued) {
					unclaimedWebcamRecorders.add(activeWebcamRecorder);
				}
				if (pendingWebcamClip && !pendingWebcamRecorderQueued) {
					unclaimedWebcamRecorders.add(pendingWebcamClip.recorder);
				}
				await nativeMacWebcamClips.current.discardUnclaimed([...unclaimedWebcamRecorders]);
				nativeMacWebcamClips.current.clear();
				if (discardRecordingId.current === activeNativeRecording.recordingId) {
					discardRecordingId.current = null;
				}
				setSaving(false);
			}
		},
		[queueNativeMacWebcamClipFinalization],
	);

	/**
	 * The Linux twin of `finalizeNativeMacRecording`. Same shape, because the two
	 * platforms make the same split: helper owns screen and audio, renderer owns
	 * the webcam, and the two are reconciled here.
	 */
	const finalizeNativeLinuxRecording = useCallback(
		async (discard = false) => {
			const activeNativeRecording = nativeLinuxRecording.current;
			if (!activeNativeRecording || activeNativeRecording.finalizing) {
				return false;
			}

			activeNativeRecording.finalizing = true;
			if (!discard) {
				setSaving(true);
			}
			const duration = Math.max(0, getRecordingDurationMs());
			const activeWebcamRecorder = webcamRecorder.current;
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}
			// See the identical comment in finalizeNativeMacRecording: the
			// leading footage recorded while the portal picker was up must
			// stay seekable, so the declared duration includes it.
			const webcamHeadStartMs = Math.max(0, -(activeNativeRecording.webcamOffsetMs ?? 0));
			const webcamDurationMs = duration + webcamHeadStartMs;
			const webcamFileName = `${RECORDING_FILE_PREFIX}${activeNativeRecording.recordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;
			const webcamResultPromise: Promise<{
				asset?: RecordedVideoAssetInput;
				error?: string;
			}> = activeWebcamRecorder
				? finalizeWebcamAsset(activeWebcamRecorder, webcamFileName, webcamDurationMs, "Linux")
				: Promise.resolve({});

			const clearNativeRecordingState = () => {
				nativeLinuxRecording.current = null;
				setRecording(false);
				setPaused(false);
				setElapsedSeconds(0);
				accumulatedDurationMs.current = 0;
				segmentStartedAt.current = null;
			};

			let webcamSaved = false;
			try {
				const result = await window.electronAPI.stopNativeLinuxRecording(discard);
				const webcamResult = await webcamResultPromise;
				if (discard || result.discarded) {
					clearNativeRecordingState();
					return true;
				}
				if (!result.success) {
					console.error("Failed to stop native Linux recording:", result.error);
					toast.error(result.error ?? "Failed to stop native Linux recording");
					// See the Windows finalizer: the main process has already
					// released its helper handle, so keeping ours leaves the HUD
					// stuck in a recording state the app can never be stopped out
					// of (issue #252).
					clearNativeRecordingState();
					return true;
				}

				if (webcamResult.asset && result.path) {
					const attachResult = await window.electronAPI.attachNativeLinuxWebcamRecording({
						screenVideoPath: result.path,
						recordingId: activeNativeRecording.recordingId,
						webcam: webcamResult.asset,
						cursorCaptureMode,
						durationMs: webcamDurationMs,
						...(typeof activeNativeRecording.webcamOffsetMs === "number"
							? { webcamOffsetMs: activeNativeRecording.webcamOffsetMs }
							: {}),
					});
					if (attachResult.success) {
						result.session = attachResult.session;
						webcamSaved = true;
					} else {
						console.error("Failed to attach native Linux webcam recording:", attachResult.error);
						toast.error(attachResult.error ?? "Failed to store webcam recording");
					}
				} else if (webcamResult.error) {
					// The screen recording still saves, so without this the editor just
					// opens with the camera missing and nothing said about it (#253).
					toast.error(`Webcam not saved (${webcamResult.error}). The screen recording was kept.`);
				}

				clearNativeRecordingState();
				if (result.session) {
					await window.electronAPI.setCurrentRecordingSession(result.session);
				} else if (result.path) {
					await window.electronAPI.setCurrentVideoPath(result.path);
				}

				await window.electronAPI.switchToEditor({ compactReview: true });
				return true;
			} catch (error) {
				console.error("Error saving native Linux recording:", error);
				toast.error(
					error instanceof Error ? error.message : "Failed to save native Linux recording",
				);
				clearNativeRecordingState();
				return true;
			} finally {
				// A webcam stream that wasn't folded into a saved session has to be closed
				// and its partial file removed, or a discarded or failed capture orphans a
				// half-written .webm now that the bytes go to disk as they arrive.
				if (activeWebcamRecorder && !webcamSaved) {
					await activeWebcamRecorder.discard().catch(() => undefined);
				}
				if (discardRecordingId.current === activeNativeRecording.recordingId) {
					discardRecordingId.current = null;
				}
				setSaving(false);
			}
		},
		[cursorCaptureMode, getRecordingDurationMs],
	);

	const stopRecording = useRef(() => {
		if (nativeWindowsRecording.current) {
			void finalizeNativeWindowsRecording(false);
			return;
		}
		if (nativeMacRecording.current) {
			void finalizeNativeMacRecording(false);
			return;
		}
		if (nativeLinuxRecording.current) {
			void finalizeNativeLinuxRecording(false);
			return;
		}

		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder) {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current;
		const duration = getRecordingDurationMs();
		const activeRecordingId = recordingId.current;

		finalizeRecording(
			activeScreenRecorder,
			activeWebcamRecorder ?? null,
			duration,
			activeRecordingId,
		);

		if (
			activeScreenRecorder.recorder.state === "recording" ||
			activeScreenRecorder.recorder.state === "paused"
		) {
			try {
				activeScreenRecorder.recorder.stop();
			} catch {
				// Recorder may already be stopping.
			}
		}
		if (activeWebcamRecorder) {
			if (
				activeWebcamRecorder.recorder.state === "recording" ||
				activeWebcamRecorder.recorder.state === "paused"
			) {
				try {
					activeWebcamRecorder.recorder.stop();
				} catch {
					// Recorder may already be stopping.
				}
			}
		}
	});

	const safeHideCountdownOverlay = useCallback(async (runId: number) => {
		try {
			await window.electronAPI.hideCountdownOverlay(runId);
		} catch (error) {
			console.warn("Failed to hide countdown overlay:", error);
		}
	}, []);

	const finalizeNativeWindowsRecordingRef = useRef(finalizeNativeWindowsRecording);
	const finalizeNativeMacRecordingRef = useRef(finalizeNativeMacRecording);
	const finalizeNativeLinuxRecordingRef = useRef(finalizeNativeLinuxRecording);
	finalizeNativeWindowsRecordingRef.current = finalizeNativeWindowsRecording;
	finalizeNativeMacRecordingRef.current = finalizeNativeMacRecording;
	finalizeNativeLinuxRecordingRef.current = finalizeNativeLinuxRecording;

	useEffect(() => {
		let cleanupTray: (() => void) | undefined;
		let cleanupNativeMacError: (() => void) | undefined;

		if (window.electronAPI?.onStopRecordingFromTray) {
			cleanupTray = window.electronAPI.onStopRecordingFromTray(() => {
				stopRecording.current();
			});
		}
		if (window.electronAPI?.onNativeMacRecordingError) {
			cleanupNativeMacError = window.electronAPI.onNativeMacRecordingError((failure) => {
				const activeRecording = nativeMacRecording.current;
				if (!activeRecording || activeRecording.finalizing) return;

				activeRecording.paused = true;
				accumulatedDurationMs.current = getRecordingDurationMs();
				segmentStartedAt.current = null;
				activeClipStartedAt.current = null;
				setPaused(true);
				setClipFinalizing(false);
				const activeWebcamRecorder = webcamRecorder.current?.recorder;
				if (activeWebcamRecorder?.state === "recording") {
					activeWebcamRecorder.pause();
				}
				toast.error(`${failure.message} Saving completed clips now.`);
				void finalizeNativeMacRecordingRef.current(false);
			});
		}

		return () => {
			const activeRunId = countdownRunId.current;
			cleanupTray?.();
			cleanupNativeMacError?.();
			countdownRunId.current += 1;
			void safeHideCountdownOverlay(activeRunId);
			allowAutoFinalize.current = false;
			restarting.current = false;
			discardRecordingId.current = null;
			if (nativeWindowsRecording.current) {
				void finalizeNativeWindowsRecordingRef.current(true);
			}
			if (nativeMacRecording.current) {
				// Keep an interrupted recording recoverable. A renderer reload or app
				// shutdown must not turn window cleanup into an explicit media discard.
				void finalizeNativeMacRecordingRef.current(false);
			}
			if (nativeLinuxRecording.current) {
				void finalizeNativeLinuxRecordingRef.current(true);
			}

			if (
				screenRecorder.current?.recorder.state === "recording" ||
				screenRecorder.current?.recorder.state === "paused"
			) {
				try {
					screenRecorder.current.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			if (
				webcamRecorder.current?.recorder.state === "recording" ||
				webcamRecorder.current?.recorder.state === "paused"
			) {
				try {
					webcamRecorder.current.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		};
	}, [teardownMedia, safeHideCountdownOverlay, getRecordingDurationMs]);
	const cancelCountdown = () => {
		const activeRunId = countdownRunId.current;
		countdownRunId.current += 1;
		setCountdownActive(false);
		void safeHideCountdownOverlay(activeRunId);
	};
	const isCountdownRunActive = (runId?: number) =>
		runId === undefined || countdownRunId.current === runId;

	const waitForWebcamReady = async () => {
		if (webcamReady.current) {
			return;
		}

		await new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (webcamReady.current) {
					clearInterval(interval);
					resolve();
				}
			}, 50);
			setTimeout(() => {
				clearInterval(interval);
				resolve();
			}, 5000);
		});
	};

	const startNativeWindowsRecordingIfAvailable = async (
		selectedSource: ProcessedDesktopSource,
		countdownRunToken?: number,
	) => {
		try {
			const platform = window.electronAPI.getPlatform();
			if (platform !== "win32") {
				return false;
			}

			const availability = await window.electronAPI.isNativeWindowsCaptureAvailable();
			if (!availability.success || !availability.available) {
				if (availability.reason === "unsupported-os") {
					return false;
				}
				if (availability.reason === "missing-helper") {
					console.warn("Native Windows capture helper is not available; using browser capture.");
					return false;
				}

				throw new Error(availability.error ?? "Native Windows capture is not available.");
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}

			const activeRecordingId = Date.now();
			const displayId = Number(selectedSource.display_id);
			const sourceType = selectedSource.id.startsWith("window:") ? "window" : "display";
			const windowHandle = parseWindowHandleFromSourceId(selectedSource.id);
			if (webcamEnabled) {
				await waitForWebcamReady();
				if (!isCountdownRunActive(countdownRunToken)) {
					return true;
				}
				// Release the renderer-side validation stream before asking the native
				// helper to open the same device: most webcams only allow one exclusive
				// capture session, and native (Media Foundation/DirectShow) now owns
				// webcam capture directly, sharing the same recording-start clock as
				// screen video and audio instead of racing a separately-started browser
				// MediaRecorder against the helper's own process-spawn/WGC-init latency.
				stopWebcamPreviewStream();
			}
			const request: NativeWindowsRecordingRequest = {
				recordingId: activeRecordingId,
				preferSoftwareEncoder: loadUserPreferences().preferSoftwareEncoder,
				source: {
					type: sourceType,
					sourceId: selectedSource.id,
					...(Number.isFinite(displayId) ? { displayId } : {}),
					...(windowHandle ? { windowHandle } : {}),
				},
				video: {
					fps: TARGET_FRAME_RATE,
					width: TARGET_WIDTH,
					height: TARGET_HEIGHT,
				},
				audio: {
					system: {
						enabled: systemAudioEnabled,
					},
					microphone: {
						enabled: microphoneEnabled,
						deviceId: microphoneDeviceId,
						deviceName: microphoneDeviceName,
						gain: MIC_GAIN_BOOST,
					},
				},
				webcam: {
					enabled: webcamEnabled,
					deviceId: webcamDeviceId,
					deviceName: webcamDeviceName,
					width: activeWebcamFormat.current.width,
					height: activeWebcamFormat.current.height,
					fps: activeWebcamFormat.current.fps,
				},
				cursor: {
					mode: cursorCaptureMode,
				},
			};
			const result = await window.electronAPI.startNativeWindowsRecording(request);
			if (!result.success || !result.recordingId) {
				throw new Error(result.error ?? "Native Windows capture failed.");
			}

			// Tell the user when the helper silently switched away from the default
			// GPU encoder; an explicit software-preferred selection needs no notice.
			setSoftwareEncoderFallbackNoticeVisible(
				result.videoEncoderSelection === "software-fallback" &&
					!loadUserPreferences().hideSoftwareEncoderFallbackNotice,
			);

			recordingId.current = result.recordingId;
			nativeWindowsRecording.current = {
				recordingId: result.recordingId,
				finalizing: false,
				paused: false,
			};
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			return true;
		} catch (error) {
			console.error("Native Windows capture failed:", error);
			throw error;
		}
	};

	const currentNativeMacRequest = (
		selectedSource: ProcessedDesktopSource,
		activeRecordingId: number,
	): NativeMacRecordingRequest =>
		buildNativeMacRecordingRequest({
			source: selectedSource,
			recordingId: activeRecordingId,
			settings: {
				recordingQuality,
				systemAudioEnabled,
				microphone: {
					enabled: microphoneEnabled,
					deviceId: microphoneDeviceId,
					deviceName: microphoneDeviceName,
					gain: MIC_GAIN_BOOST,
				},
				webcam: {
					enabled: webcamEnabled,
					deviceId: webcamDeviceId,
					deviceName: webcamDeviceName ?? webcamStream.current?.getVideoTracks()[0]?.label,
					format:
						recordingQuality === "high" && !webcamFormatAuto
							? webcamFormat
							: activeWebcamFormat.current,
					formatAuto: webcamFormatAuto,
				},
				cursorCaptureMode,
			},
		});

	const startNativeMacRecordingIfAvailable = async (
		selectedSource: ProcessedDesktopSource,
		countdownRunToken?: number,
	) => {
		try {
			const platform = window.electronAPI.getPlatform();
			if (platform !== "darwin") {
				return false;
			}

			markStart("native-start");
			const availability = await window.electronAPI.isNativeMacCaptureAvailable();
			markStart("helper-available");
			if (!availability.success || !availability.available) {
				if (availability.reason === "unsupported-platform") {
					return false;
				}

				throw new Error(
					availability.reason === "missing-helper"
						? "Native macOS capture helper is not available."
						: (availability.error ?? "Native macOS capture is not available."),
				);
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}

			if (webcamEnabled && !webcamReady.current) {
				const deadline = Date.now() + 5_000;
				while (
					!webcamReady.current &&
					Date.now() < deadline &&
					isCountdownRunActive(countdownRunToken)
				) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (!isCountdownRunActive(countdownRunToken)) return true;
				if (!webcamReady.current) throw new Error("The selected camera is not ready to record.");
				markStart("camera-ready");
			}
			const activeRecordingId = Date.now();

			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}
			markStart("start-requested");
			const request = {
				...currentNativeMacRequest(selectedSource, activeRecordingId),
				startTiming: startMarks.current,
			};
			const result = await window.electronAPI.startNativeMacRecording(request);
			if (!result.success || !result.recordingId) {
				throw new Error(result.error ?? "Native macOS capture failed.");
			}
			if (!isCountdownRunActive(countdownRunToken)) {
				await window.electronAPI.stopNativeMacRecording(true);
				return true;
			}

			// The IPC call above only resolves once the helper's stdout confirms its
			// screen capture has truly started (see waitForNativeMacCaptureStart in
			// electron/ipc/handlers.ts), so this is a reliable proxy for the native
			// recording's real t=0 in the same clock the webcam timestamp used above.
			recordingId.current = result.recordingId;
			nativeMacRecording.current = {
				recordingId: result.recordingId,
				finalizing: false,
				paused: false,
				currentClipIndex: 0,
				webcamOffsetMs: 0,
			};
			nativeMacWebcamClips.current.clear();
			setRecordedClips([]);
			setClipFinalizing(false);
			activeClipStartedAt.current = Date.now();
			setActiveClipElapsedMs(0);
			webcamRecorder.current = null;
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			return true;
		} catch (error) {
			console.error("Native macOS capture failed:", error);
			throw error;
		}
	};

	/**
	 * The Linux native path.
	 *
	 * Two things make it shorter than its Windows and macOS siblings, and both
	 * come from Wayland rather than from anything being unfinished:
	 *
	 *   * No `source`. The ScreenCast portal raises its OWN picker and the
	 *     compositor decides what it hands over. `selectedSource` is a
	 *     placeholder there, so passing it along would be passing a guess.
	 *   * The IPC call does not resolve until the user has answered that picker,
	 *     which has no upper bound. That is also what makes the returned instant
	 *     a trustworthy t=0 for the webcam offset below.
	 */
	/**
	 * The helper request, built in ONE place because it is now sent TWICE: once
	 * to negotiate the portal before the countdown, once to start recording after
	 * it. The two must describe the same capture — the session armed at the end
	 * is the one negotiated at the start, so a divergence in audio or cursor
	 * settings would record something the second call never asked for.
	 */
	const buildNativeLinuxRequest = (recordingId?: number): NativeLinuxRecordingRequest => ({
		...(recordingId === undefined ? {} : { recordingId }),
		video: {
			// No bitrate on purpose. TARGET_WIDTH/HEIGHT are the app's 4K ceiling,
			// not the capture size — on Wayland nobody knows that until the portal
			// has negotiated it, and the user may well have picked a single window.
			// Sending computeBitrate() of the ceiling asked for 76.5 Mbit/s for a
			// 1080p capture. The helper derives it from the size it actually got.
			fps: TARGET_FRAME_RATE,
		},
		audio: {
			system: { enabled: systemAudioEnabled },
			microphone: {
				enabled: microphoneEnabled,
				// The device LABEL, not the id. Chromium's deviceId is an opaque
				// per-origin hash that means nothing to PipeWire, whereas on a
				// PipeWire system the label IS the node's `node.description` — which
				// is what the helper matches against the graph it enumerates.
				// Sending nothing here is what made a user who picked their built-in
				// microphone get the empty headphone jack recorded, because the
				// helper then fell back to the session default source.
				...(microphoneDeviceName ? { deviceName: microphoneDeviceName } : {}),
				gain: MIC_GAIN_BOOST,
			},
		},
		cursor: { mode: cursorCaptureMode },
	});

	const startNativeLinuxRecordingIfAvailable = async (
		countdownRunToken?: number,
		preparedRecordingId?: number | null,
	) => {
		try {
			const platform = window.electronAPI.getPlatform();
			if (platform !== "linux") {
				return false;
			}

			const availability = await window.electronAPI.isNativeLinuxCaptureAvailable();
			if (!availability.success || !availability.available) {
				if (availability.reason === "unsupported-platform") {
					return false;
				}
				if (availability.reason === "missing-helper") {
					// The browser path still works, just without hardware encode,
					// cursor telemetry or a single picker. Falling back beats
					// refusing to record.
					console.warn("Native Linux capture helper is not available; using browser capture.");
					return false;
				}
				throw new Error(availability.error ?? "Native Linux capture is not available.");
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}

			// Reuse the prepared recording's id, or the main process cannot match
			// the session it is holding to the recording being started and would
			// discard it — negotiating a second portal session, and raising a
			// second picker, for a grant it already had.
			const activeRecordingId = preparedRecordingId ?? Date.now();
			let nativeWebcamRecorder: RecorderHandle | null = null;
			let nativeWebcamRecorderStartedAtMs: number | null = null;
			if (webcamEnabled) {
				await waitForWebcamReady();
				if (!isCountdownRunActive(countdownRunToken)) {
					return true;
				}
				if (webcamStream.current) {
					nativeWebcamRecorderStartedAtMs = performance.now();
					// See the identical comment in the macOS path: stream to disk so a long
					// recording is never flattened into one ArrayBuffer at finalize (#253).
					nativeWebcamRecorder = createRecorderHandle(
						webcamStream.current,
						{
							mimeType: selectMimeType(),
							videoBitsPerSecond: computeBitrate(
								activeWebcamFormat.current.width,
								activeWebcamFormat.current.height,
								activeWebcamFormat.current.fps,
							),
						},
						`${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`,
					);
				} else {
					webcamAcquireId.current++;
					setWebcamEnabledState(false);
				}
			}

			const result = await window.electronAPI.startNativeLinuxRecording(
				buildNativeLinuxRequest(activeRecordingId),
			);
			if (!result.success || !result.recordingId) {
				throw new Error(result.error ?? "Native Linux capture failed.");
			}
			if (!isCountdownRunActive(countdownRunToken)) {
				await window.electronAPI.stopNativeLinuxRecording(true);
				return true;
			}

			// Resolved only after the helper's first encoded frame, so this is the
			// native recording's real t=0 in the same clock the webcam used above.
			const nativeRecordingConfirmedStartedAtMs = performance.now();
			recordingId.current = result.recordingId;
			nativeLinuxRecording.current = {
				recordingId: result.recordingId,
				finalizing: false,
				paused: false,
				webcamOffsetMs: webcamOffsetMsFrom(
					nativeWebcamRecorder,
					nativeWebcamRecorderStartedAtMs,
					nativeRecordingConfirmedStartedAtMs,
				),
			};
			webcamRecorder.current = nativeWebcamRecorder;
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			return true;
		} catch (error) {
			console.error("Native Linux capture failed:", error);
			throw error;
		}
	};

	const startRecordCountdown = async () => {
		if (pendingStartRunId.current !== null || recording) return;

		startMarks.current = [];
		markStart("click");
		const runId = countdownRunId.current + 1;
		countdownRunId.current = runId;
		pendingStartRunId.current = runId;
		setCountdownActive(true);
		let portalOwnsSource = false;

		try {
			const [selectedSource, portalSelection] = await Promise.all([
				window.electronAPI.getSelectedSource().catch((error) => {
					console.warn("Failed to read selected source before recording:", error);
					return null;
				}),
				portalOwnsSourceSelection(window.electronAPI),
			]);
			portalOwnsSource = portalSelection;
			markStart("source-read");
			if (!isCountdownRunActive(runId)) return;
			if (!selectedSource && !portalOwnsSource) {
				alert(t("recording.selectSource"));
				return;
			}

			if (
				window.electronAPI.getPlatform() === "darwin" &&
				cursorCaptureMode === "editable-overlay"
			) {
				const access = await window.electronAPI.requestNativeMacCursorAccess();
				if (!access.granted || !isCountdownRunActive(runId)) return;
			}

			let preparedRecordingId: number | null = null;
			if (portalOwnsSource) {
				try {
					const prepared = await window.electronAPI.prepareNativeLinuxRecording(
						buildNativeLinuxRequest(),
					);
					if (prepared.success && typeof prepared.recordingId === "number") {
						preparedRecordingId = prepared.recordingId;
					}
				} catch (error) {
					console.warn("Failed to prepare the native Linux capture:", error);
				}
			}
			if (!isCountdownRunActive(runId)) return;

			await startRecording(runId, preparedRecordingId);
			if (!isCountdownRunActive(runId)) return;
			await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		} catch (error) {
			console.error("Failed to prepare recording:", error);
			toast.error(error instanceof Error ? error.message : "Failed to prepare recording");
		} finally {
			if (isCountdownRunActive(runId)) {
				setCountdownActive(false);
				await safeHideCountdownOverlay(runId);
			}
			if (portalOwnsSource) void window.electronAPI.cancelNativeLinuxPrepare?.();
			if (pendingStartRunId.current === runId) pendingStartRunId.current = null;
		}
	};

	const startRecording = async (
		countdownRunToken?: number,
		preparedRecordingId?: number | null,
	) => {
		if (
			recordingStartPending.current ||
			recording ||
			nativeMacRecording.current ||
			nativeWindowsRecording.current ||
			nativeLinuxRecording.current ||
			screenRecorder.current
		)
			return;
		recordingStartPending.current = true;
		try {
			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			// BEFORE THE SOURCE GATE, on purpose. On Wayland the portal raises its
			// own picker and is the only thing that can choose a source, so there
			// is nothing for the app to have selected — and the helper needs no
			// `selectedSource` to run. Gating here demanded an answer to a
			// question this platform never asks the app. It returns false when the
			// native helper is missing, and the browser fallback below does need a
			// source, so the gate still guards the path that uses one.
			if (await startNativeLinuxRecordingIfAvailable(countdownRunToken, preparedRecordingId)) {
				return;
			}

			const selectedSource = await window.electronAPI.getSelectedSource();
			if (!selectedSource) {
				alert(t("recording.selectSource"));
				return;
			}

			if (await startNativeWindowsRecordingIfAvailable(selectedSource, countdownRunToken)) {
				return;
			}
			if (await startNativeMacRecordingIfAvailable(selectedSource, countdownRunToken)) {
				return;
			}

			// Capture screen + microphone in parallel: the gap between the two
			// `getUserMedia` calls is the dominant source of the mic-vs-video lag at the
			// start of the recording (issue #57).
			const screenCapture = (async (): Promise<MediaStream> => {
				const platform = window.electronAPI.getPlatform();

				if (platform === "win32") {
					// getDisplayMedia + setDisplayMediaRequestHandler (main.ts) supplies the
					// pre-selected source. Editable cursor mode excludes the system cursor so
					// the editor can render a replacement; system mode bakes it into the video.
					return navigator.mediaDevices.getDisplayMedia({
						video: {
							cursor: cursorCaptureMode === "editable-overlay" ? "never" : "always",
							width: { max: TARGET_WIDTH },
							height: { max: TARGET_HEIGHT },
							frameRate: { ideal: TARGET_FRAME_RATE },
						} as MediaTrackConstraints,
						audio: systemAudioEnabled,
					} as DisplayMediaStreamOptions);
				}

				const videoConstraints = {
					mandatory: {
						chromeMediaSource: CHROME_MEDIA_SOURCE,
						chromeMediaSourceId: selectedSource.id,
						maxWidth: TARGET_WIDTH,
						maxHeight: TARGET_HEIGHT,
						maxFrameRate: TARGET_FRAME_RATE,
						minFrameRate: MIN_FRAME_RATE,
					},
				};
				if (systemAudioEnabled) {
					try {
						return navigator.mediaDevices.getUserMedia({
							audio: {
								mandatory: {
									chromeMediaSource: CHROME_MEDIA_SOURCE,
									chromeMediaSourceId: selectedSource.id,
								},
							},
							video: videoConstraints,
						} as unknown as MediaStreamConstraints);
					} catch (audioErr) {
						console.warn("System audio capture failed, falling back to video-only:", audioErr);
						toast.error(t("recording.systemAudioUnavailable"));
						return navigator.mediaDevices.getUserMedia({
							audio: false,
							video: videoConstraints,
						} as unknown as MediaStreamConstraints);
					}
				}

				return navigator.mediaDevices.getUserMedia({
					audio: false,
					video: videoConstraints,
				} as unknown as MediaStreamConstraints);
			})();

			const micCapture: Promise<MediaStream | null> = microphoneEnabled
				? (async () => {
						try {
							return await navigator.mediaDevices.getUserMedia({
								audio: microphoneDeviceId
									? {
											deviceId: { exact: microphoneDeviceId },
											echoCancellation: true,
											noiseSuppression: true,
											autoGainControl: true,
										}
									: {
											echoCancellation: true,
											noiseSuppression: true,
											autoGainControl: true,
										},
								video: false,
							});
						} catch (audioError) {
							console.warn("Failed to get microphone access:", audioError);
							toast.error(t("recording.microphoneDenied"));
							setMicrophoneEnabled(false);
							return null;
						}
					})()
				: Promise.resolve(null);

			// Await both in-flight captures. If the screen capture rejects it would
			// otherwise orphan a mic stream that resolved in parallel (leaving the
			// screen/mic indicator on), so stop that stream before rethrowing.
			let screenMediaStream: MediaStream;
			try {
				screenMediaStream = await screenCapture;
			} catch (error) {
				void micCapture
					.then((micStream) => micStream?.getTracks().forEach((track) => track.stop()))
					.catch(() => {
						// Mic capture itself failed too; nothing left to stop.
					});
				throw error;
			}
			const micMediaStream = await micCapture;

			// Assign the refs before the cancellation check below so teardownMedia() can
			// stop the freshly acquired streams if the countdown was cancelled mid-capture.
			screenStream.current = screenMediaStream;
			microphoneStream.current = micMediaStream;

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			if (webcamEnabled) {
				if (!webcamReady.current) {
					await new Promise<void>((resolve) => {
						const interval = setInterval(() => {
							if (webcamReady.current) {
								clearInterval(interval);
								resolve();
							}
						}, 50);
						setTimeout(() => {
							clearInterval(interval);
							resolve();
						}, 5000);
					});
				}
				if (!webcamStream.current) {
					webcamAcquireId.current++;
					setWebcamEnabledState(false);
				}
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			stream.current = new MediaStream();
			const videoTrack = screenMediaStream.getVideoTracks()[0];
			if (!videoTrack) {
				throw new Error("Video track is not available.");
			}
			stream.current.addTrack(videoTrack);

			const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
			const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

			const { context: mixingCtx, track: mixedTrack } = mixAudioTracks({
				systemAudioTrack,
				micAudioTrack,
			});
			if (mixingCtx) {
				mixingContext.current = mixingCtx;
			}
			if (mixedTrack) {
				stream.current.addTrack(mixedTrack);
			}

			try {
				await videoTrack.applyConstraints({
					frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
					width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
					height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
				});
			} catch (constraintError) {
				console.warn(
					"Unable to lock 4K/60fps constraints, using best available track settings.",
					constraintError,
				);
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			let {
				width = DEFAULT_WIDTH,
				height = DEFAULT_HEIGHT,
				frameRate = TARGET_FRAME_RATE,
			} = videoTrack.getSettings();

			width = Math.floor(width / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;
			height = Math.floor(height / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;

			const videoBitsPerSecond = computeBitrate(width, height);
			const mimeType = selectMimeType();

			console.log(
				`Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType} / ${Math.round(
					videoBitsPerSecond / BITS_PER_MEGABIT,
				)} Mbps`,
			);

			const hasAudio = stream.current.getAudioTracks().length > 0;
			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			recordingId.current = Date.now();
			const activeRecordingId = recordingId.current;
			screenRecorder.current = createRecorderHandle(
				stream.current,
				{
					mimeType,
					videoBitsPerSecond,
					...(hasAudio
						? { audioBitsPerSecond: systemAudioTrack ? AUDIO_BITRATE_SYSTEM : AUDIO_BITRATE_VOICE }
						: {}),
				},
				`${RECORDING_FILE_PREFIX}${activeRecordingId}${VIDEO_FILE_EXTENSION}`,
			);
			screenRecorder.current.recorder.addEventListener(
				"error",
				() => {
					setRecording(false);
				},
				{ once: true },
			);

			if (webcamStream.current) {
				webcamRecorder.current = createRecorderHandle(
					webcamStream.current,
					{
						mimeType,
						videoBitsPerSecond: computeBitrate(
							activeWebcamFormat.current.width,
							activeWebcamFormat.current.height,
							activeWebcamFormat.current.fps,
						),
					},
					`${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`,
				);
			}

			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			window.electronAPI?.setRecordingState(true, recordingId.current, cursorCaptureMode);

			const activeScreenRecorder = screenRecorder.current;
			const activeWebcamRecorder = webcamRecorder.current;
			if (activeScreenRecorder) {
				activeScreenRecorder.recorder.addEventListener(
					"stop",
					() => {
						if (!allowAutoFinalize.current) {
							return;
						}
						finalizeRecording(
							activeScreenRecorder,
							activeWebcamRecorder ?? null,
							Math.max(0, getRecordingDurationMs()),
							activeRecordingId,
						);
					},
					{ once: true },
				);
			}
		} catch (error) {
			console.error("Failed to start recording:", error);
			const errorMsg = error instanceof Error ? error.message : "Failed to start recording";
			if (errorMsg.includes("Permission denied") || errorMsg.includes("NotAllowedError")) {
				toast.error(t("recording.permissionDenied"));
			} else {
				toast.error(errorMsg);
			}
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		} finally {
			recordingStartPending.current = false;
		}
	};

	const togglePaused = () => {
		const activeNativeWindowsRecording = nativeWindowsRecording.current;
		if (activeNativeWindowsRecording && !activeNativeWindowsRecording.finalizing) {
			void (async () => {
				try {
					if (activeNativeWindowsRecording.paused) {
						const result = await window.electronAPI.resumeNativeWindowsRecording();
						if (!result.success) {
							throw new Error(result.error ?? "Failed to resume native Windows recording");
						}
						activeNativeWindowsRecording.paused = false;
						segmentStartedAt.current = Date.now();
						setPaused(false);
						return;
					}

					const pausedAtMs = getRecordingDurationMs();
					const result = await window.electronAPI.pauseNativeWindowsRecording();
					if (!result.success) {
						throw new Error(result.error ?? "Failed to pause native Windows recording");
					}
					activeNativeWindowsRecording.paused = true;
					accumulatedDurationMs.current = pausedAtMs;
					segmentStartedAt.current = null;
					setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
					setPaused(true);
				} catch (error) {
					console.error("Failed to toggle native Windows pause state:", error);
					toast.error(error instanceof Error ? error.message : "Failed to toggle pause state");
				}
			})();
			return;
		}

		const activeNativeMacRecording = nativeMacRecording.current;
		if (activeNativeMacRecording && !activeNativeMacRecording.finalizing) {
			void (async () => {
				const activeWebcamHandle = webcamRecorder.current;
				try {
					if (activeNativeMacRecording.paused) {
						setClipFinalizing(true);
						const selectedSource = await window.electronAPI.getSelectedSource();
						if (activeNativeMacRecording.finalizing) return;
						if (!selectedSource) {
							throw new Error("Select a screen or window before continuing.");
						}

						if (webcamEnabled && !webcamReady.current) {
							await new Promise<void>((resolve) => {
								const interval = window.setInterval(() => {
									if (webcamReady.current) {
										window.clearInterval(interval);
										resolve();
									}
								}, 50);
								window.setTimeout(() => {
									window.clearInterval(interval);
									resolve();
								}, 5_000);
							});
						}
						if (activeNativeMacRecording.finalizing) return;

						const request = currentNativeMacRequest(
							selectedSource,
							activeNativeMacRecording.recordingId,
						);
						const result = await window.electronAPI.resumeNativeMacRecording(request);
						if (!result.success) {
							if (activeNativeMacRecording.finalizing) return;
							throw new Error(result.error ?? "Failed to resume native macOS recording");
						}
						const authoritativeClipIndex = result.clipIndex;
						if (
							typeof authoritativeClipIndex !== "number" ||
							!Number.isInteger(authoritativeClipIndex) ||
							authoritativeClipIndex < 0
						) {
							throw new Error("Native macOS Continue did not return a valid clip index.");
						}
						if (activeNativeMacRecording.finalizing) return;
						webcamRecorder.current = null;
						activeNativeMacRecording.webcamOffsetMs = 0;
						activeNativeMacRecording.currentClipIndex = authoritativeClipIndex;
						activeNativeMacRecording.paused = false;
						segmentStartedAt.current = Date.now();
						activeClipStartedAt.current = Date.now();
						setActiveClipElapsedMs(0);
						setPaused(false);
						return;
					}

					const pausedAtMs = getRecordingDurationMs();
					const activeClipStartedAtMs = activeClipStartedAt.current;
					activeNativeMacRecording.paused = true;
					activeClipStartedAt.current = null;
					setPaused(true);
					setClipFinalizing(true);
					const result = await window.electronAPI.pauseNativeMacRecording();
					if (activeNativeMacRecording.finalizing) return;
					if (result.clip) {
						if (activeWebcamHandle) {
							if (webcamRecorder.current === activeWebcamHandle) webcamRecorder.current = null;
							queueNativeMacWebcamClipFinalization(
								activeNativeMacRecording,
								result.clip,
								activeWebcamHandle,
								activeNativeMacRecording.webcamOffsetMs ?? 0,
							);
							activeNativeMacRecording.webcamOffsetMs = null;
						}
						setRecordedClips((clips) =>
							clips.some((clip) => clip.index === result.clip?.index)
								? clips
								: [...clips, result.clip as RecordingSessionClip].sort((a, b) => a.index - b.index),
						);
					}
					if (!result.success) {
						if (result.paused !== true) {
							activeNativeMacRecording.paused = false;
							activeClipStartedAt.current = activeClipStartedAtMs;
							setPaused(false);
						} else {
							if (!result.clip && activeWebcamHandle) {
								if (webcamRecorder.current === activeWebcamHandle) webcamRecorder.current = null;
								await discardWebcamRecorder(activeWebcamHandle);
								activeNativeMacRecording.webcamOffsetMs = null;
							}
							accumulatedDurationMs.current = pausedAtMs;
							segmentStartedAt.current = null;
							setElapsedSeconds(Math.floor(pausedAtMs / 1000));
						}
						throw new Error(result.error ?? "Failed to pause native macOS recording");
					}
					if (!result.clip && activeWebcamHandle) {
						if (webcamRecorder.current === activeWebcamHandle) webcamRecorder.current = null;
						await discardWebcamRecorder(activeWebcamHandle);
						activeNativeMacRecording.webcamOffsetMs = null;
					}
					accumulatedDurationMs.current = pausedAtMs;
					segmentStartedAt.current = null;
					setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
				} catch (error) {
					const pendingWebcamClip = pendingNativeMacWebcamClip.current;
					if (
						pendingWebcamClip?.recordingId === activeNativeMacRecording.recordingId &&
						!activeNativeMacRecording.finalizing
					) {
						pendingNativeMacWebcamClip.current = null;
						await discardWebcamRecorder(pendingWebcamClip.recorder);
					}
					if (activeNativeMacRecording.finalizing) return;
					console.error("Failed to toggle native macOS pause state:", error);
					toast.error(error instanceof Error ? error.message : "Failed to toggle pause state");
				} finally {
					setClipFinalizing(false);
				}
			})();
			return;
		}

		const activeNativeLinuxRecording = nativeLinuxRecording.current;
		if (activeNativeLinuxRecording && !activeNativeLinuxRecording.finalizing) {
			void (async () => {
				const activeWebcamRecorder = webcamRecorder.current?.recorder;
				try {
					if (activeNativeLinuxRecording.paused) {
						const result = await window.electronAPI.resumeNativeLinuxRecording();
						if (!result.success) {
							throw new Error(result.error ?? "Failed to resume native Linux recording");
						}
						if (activeWebcamRecorder?.state === "paused") {
							activeWebcamRecorder.resume();
						}
						activeNativeLinuxRecording.paused = false;
						segmentStartedAt.current = Date.now();
						setPaused(false);
						return;
					}

					const pausedAtMs = getRecordingDurationMs();
					const result = await window.electronAPI.pauseNativeLinuxRecording();
					if (!result.success) {
						throw new Error(result.error ?? "Failed to pause native Linux recording");
					}
					if (activeWebcamRecorder?.state === "recording") {
						activeWebcamRecorder.pause();
					}
					activeNativeLinuxRecording.paused = true;
					accumulatedDurationMs.current = pausedAtMs;
					segmentStartedAt.current = null;
					setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
					setPaused(true);
				} catch (error) {
					console.error("Failed to toggle native Linux pause state:", error);
					toast.error(error instanceof Error ? error.message : "Failed to toggle pause state");
				}
			})();
			return;
		}

		const activeScreenRecorder = screenRecorder.current?.recorder;
		if (!activeScreenRecorder || activeScreenRecorder.state === "inactive") {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current?.recorder;

		if (activeScreenRecorder.state === "paused") {
			try {
				activeScreenRecorder.resume();
				if (activeWebcamRecorder?.state === "paused") {
					activeWebcamRecorder.resume();
				}
				segmentStartedAt.current = Date.now();
				setPaused(false);
			} catch (error) {
				console.error("Failed to resume recording:", error);
			}
			return;
		}

		if (activeScreenRecorder.state !== "recording") {
			return;
		}

		try {
			accumulatedDurationMs.current = getRecordingDurationMs();
			segmentStartedAt.current = null;
			setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
			activeScreenRecorder.pause();
			if (activeWebcamRecorder?.state === "recording") {
				activeWebcamRecorder.pause();
			}
			setPaused(true);
		} catch (error) {
			console.error("Failed to pause recording:", error);
		}
	};

	const removePreviousClip = async (): Promise<RecordingSessionClip | null> => {
		const activeNativeMacRecording = nativeMacRecording.current;
		if (!activeNativeMacRecording || clipFinalizing) return null;
		try {
			const result = await window.electronAPI.removePreviousNativeMacClip();
			if (!result.success) {
				throw new Error(result.error ?? "Failed to remove the previous clip");
			}
			const removedClip = result.clip;
			if (removedClip) {
				setRecordedClips((clips) => clips.filter((clip) => clip.index !== removedClip.index));
			}
			return removedClip ?? null;
		} catch (error) {
			console.error("Failed to remove the previous clip:", error);
			toast.error(error instanceof Error ? error.message : "Failed to remove the previous clip");
			return null;
		}
	};

	const restoreRemovedClip = async (clipIndex: number): Promise<RecordingSessionClip | null> => {
		if (!nativeMacRecording.current || clipFinalizing) return null;
		try {
			const result = await window.electronAPI.restoreRemovedNativeMacClip(clipIndex);
			if (!result.success) {
				throw new Error(result.error ?? "Failed to restore the removed clip");
			}
			const restoredClip = result.clip;
			if (restoredClip) {
				setRecordedClips((clips) => {
					const withoutDuplicate = clips.filter((clip) => clip.index !== restoredClip.index);
					return [...withoutDuplicate, restoredClip].sort(
						(left, right) => left.index - right.index,
					);
				});
			}
			return restoredClip ?? null;
		} catch (error) {
			console.error("Failed to restore the removed clip:", error);
			toast.error(error instanceof Error ? error.message : "Failed to restore the removed clip");
			return null;
		}
	};

	const toggleRecording = () => {
		if (recording) {
			stopRecording.current();
			return;
		}

		if (countdownActive) {
			cancelCountdown();
			return;
		}

		void startRecordCountdown();
	};

	const restartRecording = async () => {
		if (restarting.current) return;

		if (nativeWindowsRecording.current) {
			const activeRecordingId = recordingId.current;
			restarting.current = true;
			discardRecordingId.current = activeRecordingId;
			try {
				await finalizeNativeWindowsRecording(true);
				await startRecording();
			} finally {
				restarting.current = false;
			}
			return;
		}
		if (nativeMacRecording.current) {
			const activeRecordingId = recordingId.current;
			restarting.current = true;
			discardRecordingId.current = activeRecordingId;
			try {
				await finalizeNativeMacRecording(true);
				await startRecording();
			} finally {
				restarting.current = false;
			}
			return;
		}
		if (nativeLinuxRecording.current) {
			const activeRecordingId = recordingId.current;
			restarting.current = true;
			discardRecordingId.current = activeRecordingId;
			try {
				await finalizeNativeLinuxRecording(true);
				await startRecording();
			} finally {
				restarting.current = false;
			}
			return;
		}

		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder || activeScreenRecorder.recorder.state === "inactive") return;

		const activeWebcamRecorder = webcamRecorder.current;
		const activeRecordingId = recordingId.current;

		restarting.current = true;
		discardRecordingId.current = activeRecordingId;

		const stopPromises = [
			new Promise<void>((resolve) => {
				activeScreenRecorder.recorder.addEventListener("stop", () => resolve(), { once: true });
			}),
		];

		if (
			activeWebcamRecorder?.recorder.state === "recording" ||
			activeWebcamRecorder?.recorder.state === "paused"
		) {
			stopPromises.push(
				new Promise<void>((resolve) => {
					activeWebcamRecorder.recorder.addEventListener("stop", () => resolve(), {
						once: true,
					});
				}),
			);
		}

		stopRecording.current();
		await Promise.all(stopPromises);

		try {
			await startRecording();
		} finally {
			restarting.current = false;
		}
	};

	useEffect(() => {
		if (!recording) {
			setElapsedSeconds(0);
			setActiveClipElapsedMs(0);
			return;
		}

		const updateElapsedTime = () => {
			const activeMs =
				activeClipStartedAt.current === null ? 0 : Date.now() - activeClipStartedAt.current;
			setActiveClipElapsedMs(activeMs);
			setElapsedSeconds(
				Math.floor(
					(nativeMacRecording.current
						? getKeptRecordingDurationMs(recordedClips) + activeMs
						: getRecordingDurationMs()) / 1000,
				),
			);
		};

		updateElapsedTime();
		if (paused) {
			return;
		}

		const interval = window.setInterval(updateElapsedTime, 250);

		return () => window.clearInterval(interval);
	}, [getRecordingDurationMs, paused, recordedClips, recording]);

	const cancelRecording = () => {
		if (nativeWindowsRecording.current) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;
			void finalizeNativeWindowsRecording(true);
			return;
		}
		if (nativeMacRecording.current) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;
			void finalizeNativeMacRecording(true);
			return;
		}
		if (nativeLinuxRecording.current) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;
			void finalizeNativeLinuxRecording(true);
			return;
		}

		const activeScreenRecorder = screenRecorder.current;
		if (
			activeScreenRecorder?.recorder.state === "recording" ||
			activeScreenRecorder?.recorder.state === "paused"
		) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;

			stopRecording.current();
			return;
		}

		if (countdownActive) {
			cancelCountdown();
			return;
		}
	};

	const dismissSoftwareEncoderFallbackNotice = (dontShowAgain = false) => {
		if (dontShowAgain) {
			saveUserPreferences({ hideSoftwareEncoderFallbackNotice: true });
		}
		setSoftwareEncoderFallbackNoticeVisible(false);
	};

	return {
		recording,
		starting: countdownActive,
		paused,
		saving,
		clipFinalizing,
		elapsedSeconds,
		activeClipElapsedMs,
		recordedClips,
		toggleRecording,
		preferencesReady,
		startRecordingImmediately: () => startRecording(),
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
		microphoneDeviceName,
		setMicrophoneDeviceName,
		webcamDeviceId,
		setWebcamDeviceId,
		webcamDeviceName,
		setWebcamDeviceName,
		recordingQuality,
		setRecordingQuality,
		webcamFormat,
		setWebcamFormat,
		webcamFormatAuto,
		setWebcamFormatAuto,
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		webcamPreviewStream,
		setWebcamEnabled,
		cursorCaptureMode,
		setCursorCaptureMode,
		softwareEncoderFallbackNoticeVisible,
		dismissSoftwareEncoderFallbackNotice,
	};
}

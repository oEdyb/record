import type { Rectangle } from "electron";
import type { RecordingQuality } from "./recording/recordingQuality";
import type {
	CursorCaptureMode,
	RecordedVideoAssetInput,
	RecordingSessionClip,
} from "./recordingSession";
import { normalizeCursorCaptureMode, normalizeRecordingOriginals } from "./recordingSession";

type NativeMacSourceType = "display" | "window";

/** A moment on the way from the Record click to the first saved frame, in epoch ms. */
export type RecordStartMark = { stage: string; atMs: number };

export type NativeMacRecordingRequest = {
	schemaVersion: 1;
	recordingId?: number;
	/** The renderer's steps since the click, so main can log where start time goes. */
	startTiming?: RecordStartMark[];
	source: {
		type: NativeMacSourceType;
		sourceId: string;
		displayId?: number;
		windowId?: number;
		excludedWindowIds?: number[];
		excludedProcessIds?: number[];
		bounds?: Rectangle;
	};
	video: {
		quality?: RecordingQuality;
		fps: number;
		width: number;
		height: number;
		bitrate?: number;
		hideSystemCursor: boolean;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			deviceId?: string;
			deviceName?: string;
			gain: number;
		};
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		width: number;
		height: number;
		fps: number;
		/** Record this native width/height/fps as chosen instead of the Automatic format. */
		exactFormat?: boolean;
	};
	cursor: {
		mode: CursorCaptureMode;
	};
	outputs: {
		screenPath: string;
		manifestPath?: string;
	};
};

export type NativeMacOriginalStarted = {
	clipIndex: number;
	key: "webcamVideoPath" | "microphoneAudioPath" | "systemAudioPath";
	path: string;
	offsetMs: number;
};

export function parseNativeMacOriginalStarted(value: unknown): NativeMacOriginalStarted | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (
		typeof raw.clipIndex !== "number" ||
		!Number.isSafeInteger(raw.clipIndex) ||
		raw.clipIndex < 0 ||
		(raw.key !== "webcamVideoPath" &&
			raw.key !== "microphoneAudioPath" &&
			raw.key !== "systemAudioPath") ||
		typeof raw.path !== "string" ||
		!raw.path.trim() ||
		typeof raw.offsetMs !== "number" ||
		!Number.isFinite(raw.offsetMs) ||
		raw.offsetMs < 0
	)
		return null;
	return { clipIndex: raw.clipIndex, key: raw.key, path: raw.path, offsetMs: raw.offsetMs };
}

type NativeMacMetricSummary = {
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
};

export type NativeMacCaptureTelemetry = {
	writerBackpressureEvents?: number;
	repeatedVideoFrames?: number;
	completeSourceVideoFps?: number;
	appendedCameraFrames?: number;
	originalBackpressureEvents?: number;
	originalMaxQueueDepth?: number;
	completeSourceCameraFps?: number;
	cameraSamples?: number;
	cameraDroppedFrames?: number;
	deliveredCameraFps?: number;
	requestedVideoFps: number;
	deliveredVideoFps: number;
	screenSamples: number;
	completeScreenSamples: number;
	idleScreenSamples: number;
	blankScreenSamples: number;
	suspendedScreenSamples: number;
	startedScreenSamples: number;
	stoppedScreenSamples: number;
	otherScreenSamples: number;
	appendedVideoFrames: number;
	pendingVideoFrames: number;
	appendFailures: number;
	droppedVideoFrames: number;
	systemAudioSamples: number;
	microphoneAudioSamples: number;
	audioMaxQueueBytes?: number;
	writerMaxQueueDepth?: number;
	lowPowerMode: boolean;
	thermalState: "unknown" | "nominal" | "fair" | "serious" | "critical";
	systemAudioDriftMs?: NativeMacMetricSummary;
	screenTimestampDriftMs?: NativeMacMetricSummary;
	screenDeliveryAgeMs?: NativeMacMetricSummary;
	completeScreenIntervalMs?: NativeMacMetricSummary;
	microphoneDriftMs?: NativeMacMetricSummary;
	fragmentFinalizeMs?: NativeMacMetricSummary;
	audioBlockMs?: NativeMacMetricSummary;
};

export type NativeMacRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	error?: string;
};

export type NativeMacClipWebcamInput = {
	clipIndex: number;
	webcam: RecordedVideoAssetInput;
	durationMs: number;
	webcamOffsetMs: number;
};

export type NativeMacRecordingFailure = {
	code: string;
	message: string;
};

/** Why the app asks the HUD to pause, or that the captured content came back. */
export type NativeMacRecordingInterruption =
	| "source-inactive"
	| "source-active"
	| "screen-locked"
	| "system-sleep";

export function parseNativeMacRecordingClip(value: unknown): RecordingSessionClip | null {
	if (!value || typeof value !== "object") return null;
	const clip = value as Partial<RecordingSessionClip>;
	if (
		typeof clip.index !== "number" ||
		!Number.isInteger(clip.index) ||
		clip.index < 0 ||
		typeof clip.screenVideoPath !== "string" ||
		!clip.screenVideoPath.trim() ||
		typeof clip.durationMs !== "number" ||
		!Number.isFinite(clip.durationMs) ||
		clip.durationMs < 0
	) {
		return null;
	}
	const cursorCaptureMode = normalizeCursorCaptureMode(clip.cursorCaptureMode);
	return {
		...normalizeRecordingOriginals(clip),
		index: clip.index,
		screenVideoPath: clip.screenVideoPath,
		durationMs: clip.durationMs,
		...(clip.removed === true ? { removed: true } : {}),
		...(cursorCaptureMode ? { cursorCaptureMode } : {}),
	};
}

export function parseMacWindowIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("window:")) {
		return null;
	}

	const windowIdPart = sourceId.split(":")[1];
	if (!windowIdPart || !/^\d+$/.test(windowIdPart)) {
		return null;
	}

	return Number(windowIdPart);
}

export function parseMacDisplayIdFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("screen:")) {
		return null;
	}

	const displayIdPart = sourceId.split(":")[1];
	if (!displayIdPart || !/^\d+$/.test(displayIdPart)) {
		return null;
	}

	return Number(displayIdPart);
}

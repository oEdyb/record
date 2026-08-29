import type { Rectangle } from "electron";
import type {
	CursorCaptureMode,
	RecordedVideoAssetInput,
	RecordingSessionClip,
} from "./recordingSession";
import { normalizeCursorCaptureMode } from "./recordingSession";

export type NativeMacSourceType = "display" | "window";

export type NativeMacRecordingRequest = {
	schemaVersion: 1;
	recordingId?: number;
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
	};
	cursor: {
		mode: CursorCaptureMode;
	};
	outputs: {
		screenPath: string;
		manifestPath?: string;
	};
};

export type NativeMacHelperReadyEvent = {
	event: "ready";
	schemaVersion: 1;
};

export type NativeMacHelperRecordingStartedEvent = {
	event: "recording-started";
	timestampMs: number;
	captureBounds?: Rectangle;
};

export type NativeMacHelperClipFinalizedEvent = {
	event: "clip-finalized";
	clip: RecordingSessionClip;
};

export type NativeMacHelperRecordingPausedEvent = {
	event: "recording-paused";
	timestampMs: number;
};

export type NativeMacHelperRecordingResumedEvent = {
	event: "recording-resumed";
	timestampMs: number;
};

export type NativeMacHelperRecordingReconfiguredEvent = {
	event: "recording-reconfigured";
	timestampMs: number;
	captureBounds?: Rectangle;
};

export type NativeMacHelperRecordingStoppedEvent = {
	event: "recording-stopped";
	screenPath: string;
	clips: RecordingSessionClip[];
	warning?: {
		code: string;
		message: string;
	};
	telemetry?: NativeMacCaptureTelemetry;
};

export type NativeMacMetricSummary = {
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
};

export type NativeMacCaptureTelemetry = {
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
	microphoneDriftMs?: NativeMacMetricSummary;
	fragmentFinalizeMs?: NativeMacMetricSummary;
	audioBlockMs?: NativeMacMetricSummary;
};

export type NativeMacHelperWarningEvent = {
	event: "warning";
	code: string;
	message: string;
};

export type NativeMacHelperErrorEvent = {
	event: "error";
	code: string;
	message: string;
};

export type NativeMacHelperEvent =
	| NativeMacHelperReadyEvent
	| NativeMacHelperRecordingStartedEvent
	| NativeMacHelperClipFinalizedEvent
	| NativeMacHelperRecordingPausedEvent
	| NativeMacHelperRecordingReconfiguredEvent
	| NativeMacHelperRecordingResumedEvent
	| NativeMacHelperRecordingStoppedEvent
	| NativeMacHelperWarningEvent
	| NativeMacHelperErrorEvent;

export type NativeMacRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	error?: string;
};

export type NativeMacRecordingClipResult = {
	success: boolean;
	clip?: RecordingSessionClip;
	paused?: boolean;
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

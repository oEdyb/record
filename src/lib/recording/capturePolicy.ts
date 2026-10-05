import type { NativeMacRecordingRequest } from "../nativeMacRecording";
import { parseMacDisplayIdFromSourceId, parseMacWindowIdFromSourceId } from "../nativeMacRecording";
import type { CursorCaptureMode } from "../recordingSession";
import type { WebcamFormat } from "../webcamFormats";
import {
	normalizeRecordingQuality,
	type RecordingQuality,
	recordingQualityBitrate,
} from "./recordingQuality";

export const TARGET_FRAME_RATE = 60;
export const MIN_FRAME_RATE = 30;
export const TARGET_WIDTH = 3840;
export const TARGET_HEIGHT = 2160;

const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
const QHD_PIXELS = 2560 * 1440;
const BITRATE_4K = 45_000_000;
const BITRATE_QHD = 28_000_000;
const BITRATE_BASE = 18_000_000;
const HIGH_FRAME_RATE_THRESHOLD = 60;
const HIGH_FRAME_RATE_BOOST = 1.7;

export type CaptureSource = {
	id: string;
	display_id?: string;
};

export type NativeMacCaptureSettings = {
	recordingQuality?: RecordingQuality;
	systemAudioEnabled: boolean;
	microphone: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		gain: number;
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		format: WebcamFormat;
		/** High only: true lets the helper pick the sharpest native format. */
		formatAuto: boolean;
	};
	cursorCaptureMode: CursorCaptureMode;
};

export function selectRecorderMimeType(isSupported: (type: string) => boolean): string {
	// H.264 first: hardware acceleration keeps sharp real-time output. AV1 and
	// VP9 are useful for distribution, but their software encoders can fall
	// behind during live 60 fps capture.
	const preferred = [
		"video/webm;codecs=h264",
		"video/webm;codecs=vp8",
		"video/webm;codecs=vp9",
		"video/webm;codecs=av1",
		"video/webm",
	];

	return preferred.find(isSupported) ?? "video/webm";
}

export function computeCaptureBitrate(
	width: number,
	height: number,
	frameRate = TARGET_FRAME_RATE,
): number {
	const pixels = width * height;
	const highFrameRateBoost = frameRate >= HIGH_FRAME_RATE_THRESHOLD ? HIGH_FRAME_RATE_BOOST : 1;

	if (pixels >= FOUR_K_PIXELS) return Math.round(BITRATE_4K * highFrameRateBoost);
	if (pixels >= QHD_PIXELS) return Math.round(BITRATE_QHD * highFrameRateBoost);
	return Math.round(BITRATE_BASE * highFrameRateBoost);
}

export function buildNativeMacRecordingRequest(input: {
	source: CaptureSource;
	recordingId: number;
	settings: NativeMacCaptureSettings;
}): NativeMacRecordingRequest {
	const { source, recordingId, settings } = input;
	const sourceType = source.id.startsWith("window:") ? "window" : "display";
	const displayId = Number(source.display_id) || parseMacDisplayIdFromSourceId(source.id);
	const windowId = parseMacWindowIdFromSourceId(source.id);
	const quality = normalizeRecordingQuality(settings.recordingQuality);

	return {
		schemaVersion: 1,
		recordingId,
		source: {
			type: sourceType,
			sourceId: source.id,
			...(displayId ? { displayId } : {}),
			...(windowId ? { windowId } : {}),
		},
		video: {
			fps: TARGET_FRAME_RATE,
			width: TARGET_WIDTH,
			height: TARGET_HEIGHT,
			quality,
			bitrate: recordingQualityBitrate(quality),
			hideSystemCursor: settings.cursorCaptureMode === "editable-overlay",
		},
		audio: {
			system: { enabled: settings.systemAudioEnabled },
			microphone: settings.microphone,
		},
		webcam: {
			enabled: settings.webcam.enabled,
			deviceId: settings.webcam.deviceId,
			deviceName: settings.webcam.deviceName,
			...settings.webcam.format,
			exactFormat: quality === "high" && !settings.webcam.formatAuto,
		},
		cursor: { mode: settings.cursorCaptureMode },
		outputs: { screenPath: "" },
	};
}

export function nativeMacWebcamFileName(recordingId: number, clipIndex: number): string {
	return `recording-${recordingId}-clip-${String(clipIndex + 1).padStart(4, "0")}-webcam.webm`;
}

function fileStem(filePath: string): string {
	const name = filePath.split(/[\\/]/).pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * True when the camera file was recorded for exactly this screen clip (macOS records one
 * camera file per clip, named after the clip). Such a file starts at the clip's own start,
 * so its offset must not be shifted by earlier clips. A camera file that spans the whole
 * session (one continuous file shared by every clip) is named after the recording instead.
 */
export function isClipOwnedWebcamPath(screenVideoPath: string, webcamVideoPath: string): boolean {
	return fileStem(webcamVideoPath) === `${fileStem(screenVideoPath)}-webcam`;
}

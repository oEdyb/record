import type {
	NativeMacRecordingRequest,
	NativeRecordingAppStopRequest,
} from "./nativeMacRecording";
import { recordingQualityBitrate } from "./recording/recordingQuality";

export type NativeLinuxSourceSelectionResult = {
	success: boolean;
	cancelled?: boolean;
	error?: string;
};

/** Legacy Linux IPC input, adapted to the shared clip-native request at the boundary.
 * Source selection belongs to the portal. The renderer records per-clip cameras;
 * complete microphone/system originals belong to the native helper.
 */
export type NativeLinuxRecordingRequest = {
	recordingId?: number;
	video: {
		fps: number;
		bitrate?: number;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			/**
			 * A PipeWire `node.name`, NOT the browser device id the UI carries.
			 * The two namespaces are unrelated and there is no mapping between
			 * them, so this is left empty until the picker learns to enumerate
			 * PipeWire nodes; empty means the session's default source.
			 */
			deviceName?: string;
			gain: number;
		};
	};
	cursor: {
		mode: import("./recordingSession").CursorCaptureMode;
	};
};

/** Retains existing Linux IPC callers while using the shared clip-native helper contract. */
export function linuxClipRecordingRequest(
	request: NativeLinuxRecordingRequest | NativeMacRecordingRequest,
): NativeMacRecordingRequest {
	if ("schemaVersion" in request) {
		return { ...request, platform: "linux", webcam: { ...request.webcam, enabled: false } };
	}
	return {
		schemaVersion: 1,
		platform: "linux",
		recordingId: request.recordingId,
		source: { type: "display", sourceId: "portal:selected" },
		video: {
			width: 3840,
			height: 2160,
			fps: request.video.fps,
			quality: "high",
			bitrate: request.video.bitrate ?? recordingQualityBitrate("high"),
			hideSystemCursor: request.cursor.mode === "editable-overlay",
		},
		audio: request.audio,
		webcam: { enabled: false, width: 1920, height: 1080, fps: 60 },
		cursor: request.cursor,
		outputs: { screenPath: "" },
	};
}

/** The slice of `window.electronAPI` the check below needs. */
type SourceSelectionProbe = {
	getPlatform: () => string;
	isNativeLinuxCaptureAvailable: () => Promise<{ success: boolean; available: boolean }>;
};

/**
 * Whether the ScreenCast portal — not the app — chooses what gets recorded.
 *
 * True only on Linux WITH the PipeWire helper. `SelectSources` has no parameter
 * naming a source, so there is nothing for the app to have selected and every
 * `selectedSource` gate must stand down. Everywhere else those gates are
 * load-bearing: both other native paths consume a source id. The native Record
 * path reports an unavailable helper explicitly; it never falls back to browser capture.
 *
 * Lives here rather than inline in `useScreenRecorder` because the recorder asks
 * this question in TWO places — once before the countdown and once before
 * capture — and fixing only the second left the countdown refusing to start at
 * all, with an alert about a source the HUD no longer offers any way to pick.
 */
export async function portalOwnsSourceSelection(api: SourceSelectionProbe): Promise<boolean> {
	if (api.getPlatform() !== "linux") {
		return false;
	}
	try {
		const availability = await api.isNativeLinuxCaptureAvailable();
		return Boolean(availability?.success && availability.available);
	} catch (error) {
		// Availability failures remain visible to callers. The recorder independently
		// enforces Linux native capture and reports the helper error at Record.
		console.warn("Failed to check native Linux capture availability:", error);
		return false;
	}
}

export type NativeLinuxRecordingStartResult = {
	success: boolean;
	rendererStop?: NativeRecordingAppStopRequest;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	error?: string;
	/** "vaapi", "vulkan" or "software" — which rung of the encoder ladder won. */
	videoEncoder?: string | null;
};

/**
 * The portal's cursor modes, as the helper's `cursorMode` field spells them.
 *
 * METADATA is what makes the editable cursor possible: the compositor keeps the
 * pointer out of the captured pixels and describes its position separately, so
 * the editor can draw its own without the real one showing through underneath.
 * EMBEDDED is the opposite and matches the HUD's "system cursor" setting.
 */
export function portalCursorMode(
	mode: import("./recordingSession").CursorCaptureMode,
): "metadata" | "embedded" {
	return mode === "system" ? "embedded" : "metadata";
}

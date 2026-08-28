export interface ProjectMedia {
	screenVideoPath: string;
	webcamVideoPath?: string;
	/**
	 * Milliseconds to shift the webcam asset's playback position relative to
	 * the screen recording. Negative when the webcam started capturing before
	 * the screen recording's real start (e.g. the browser MediaRecorder for
	 * the webcam is started in the renderer before the native Windows helper
	 * process finishes spawning and confirms recording), so the editor skips
	 * that much extra leading footage instead of showing stale camera frames.
	 */
	webcamOffsetMs?: number;
	cursorCaptureMode?: CursorCaptureMode;
}

export type CursorCaptureMode = "editable-overlay" | "system";

/**
 * Editor state parked while the recording HUD is open.
 *
 * The HUD and editor use separate Electron windows, so renderer memory does not
 * survive the switch. This small main-process hand-off restores the same project
 * and timeline boundary after Stop, or after leaving the idle HUD.
 */
export interface RecordingWorkspaceContext {
	origin: "editor";
	projectId: string;
	insertionTimeSec: number;
	currentTimeSec: number;
	mode: "media" | "edit";
	inspectorOpen: boolean;
	facet:
		| "background"
		| "effects"
		| "layout"
		| "cursor"
		| "audio"
		| "automatic"
		| "captions"
		| "transcript";
}

export interface RecordingSession extends ProjectMedia {
	createdAt: number;
	/** Project reserved for a standalone import that may resume after interruption. */
	importProjectId?: string;
	/**
	 * Ordered media files produced by clip-native recording. The legacy
	 * `screenVideoPath` above remains the compatibility path for recordings made
	 * before schema version 2 and for parts of the app that still need one anchor
	 * file. Removed clips stay in this list until normal cleanup so the recorder
	 * never has to delete media in the Backspace interaction.
	 */
	clips?: RecordingSessionClip[];
	schemaVersion?: 2;
}

export interface RecordingSessionClip {
	index: number;
	screenVideoPath: string;
	durationMs: number;
	removed?: boolean;
	/**
	 * The helper was interrupted before it could report the exact duration. The
	 * editor uses the normal 60-second probe placeholder, then replaces it with
	 * the media duration as soon as the recovered file loads.
	 */
	provisionalDuration?: boolean;
	/** Capture style used for this clip. Paused changes apply to the next clip only. */
	cursorCaptureMode?: CursorCaptureMode;
}

export interface RecordedVideoAssetInput {
	fileName: string;
	videoData: ArrayBuffer;
}

export interface StoreRecordedSessionInput {
	screen: RecordedVideoAssetInput;
	webcam?: RecordedVideoAssetInput;
	createdAt?: number;
	cursorCaptureMode?: CursorCaptureMode;
	/**
	 * Recording wall-clock duration (ms). The main process patches the WebM Duration
	 * header on streamed recordings (the renderer no longer holds the bytes). Browser
	 * MediaRecorder writes no/zero duration, which breaks the editor seek bar and
	 * timeline for anything that took the streaming path.
	 */
	durationMs?: number;
	/** See {@link ProjectMedia.webcamOffsetMs}. */
	webcamOffsetMs?: number;
}

export function normalizeCursorCaptureMode(value: unknown): CursorCaptureMode | undefined {
	return value === "editable-overlay" || value === "system" ? value : undefined;
}

export function normalizeRecordingWorkspaceContext(
	candidate: unknown,
): RecordingWorkspaceContext | null {
	if (!candidate || typeof candidate !== "object") return null;
	const raw = candidate as Partial<RecordingWorkspaceContext>;
	const projectId = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
	const finiteNonnegative = (value: unknown): value is number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0;
	const facet = (raw as { facet?: unknown }).facet;
	const normalizedFacet = facet === "pauses" ? "audio" : facet;
	if (
		raw.origin !== "editor" ||
		!projectId ||
		!finiteNonnegative(raw.insertionTimeSec) ||
		!finiteNonnegative(raw.currentTimeSec) ||
		(raw.mode !== "media" && raw.mode !== "edit") ||
		typeof raw.inspectorOpen !== "boolean" ||
		(normalizedFacet !== "background" &&
			normalizedFacet !== "effects" &&
			normalizedFacet !== "layout" &&
			normalizedFacet !== "cursor" &&
			normalizedFacet !== "audio" &&
			normalizedFacet !== "automatic" &&
			normalizedFacet !== "captions" &&
			normalizedFacet !== "transcript")
	) {
		return null;
	}

	return {
		origin: "editor",
		projectId,
		insertionTimeSec: raw.insertionTimeSec,
		currentTimeSec: raw.currentTimeSec,
		mode: raw.mode,
		inspectorOpen: raw.inspectorOpen,
		facet: normalizedFacet,
	};
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeProjectMedia(candidate: unknown): ProjectMedia | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<ProjectMedia>;
	const screenVideoPath = normalizePath(raw.screenVideoPath);

	if (!screenVideoPath) {
		return null;
	}

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	const cursorCaptureMode = normalizeCursorCaptureMode(raw.cursorCaptureMode);
	const webcamOffsetMs =
		typeof raw.webcamOffsetMs === "number" && Number.isFinite(raw.webcamOffsetMs)
			? raw.webcamOffsetMs
			: undefined;

	return {
		screenVideoPath,
		...(webcamVideoPath ? { webcamVideoPath } : {}),
		...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
		...(cursorCaptureMode ? { cursorCaptureMode } : {}),
	};
}

export function normalizeRecordingSession(candidate: unknown): RecordingSession | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<RecordingSession>;
	const media = normalizeProjectMedia(raw);
	if (!media) {
		return null;
	}

	const clips = Array.isArray(raw.clips)
		? raw.clips
				.map((clip): RecordingSessionClip | null => {
					if (!clip || typeof clip !== "object") return null;
					const value = clip as Partial<RecordingSessionClip>;
					const screenVideoPath = normalizePath(value.screenVideoPath);
					if (
						!screenVideoPath ||
						typeof value.index !== "number" ||
						!Number.isInteger(value.index) ||
						value.index < 0 ||
						typeof value.durationMs !== "number" ||
						!Number.isFinite(value.durationMs) ||
						value.durationMs < 0
					) {
						return null;
					}
					return {
						index: value.index,
						screenVideoPath,
						durationMs: value.durationMs,
						...(value.removed === true ? { removed: true } : {}),
						...(value.provisionalDuration === true ? { provisionalDuration: true } : {}),
						...(normalizeCursorCaptureMode(value.cursorCaptureMode)
							? { cursorCaptureMode: normalizeCursorCaptureMode(value.cursorCaptureMode) }
							: {}),
					};
				})
				.filter((clip): clip is RecordingSessionClip => clip !== null)
				.sort((a, b) => a.index - b.index)
		: undefined;
	const importProjectId =
		typeof raw.importProjectId === "string" && /^[A-Za-z0-9_-]+$/.test(raw.importProjectId.trim())
			? raw.importProjectId.trim()
			: undefined;

	return {
		...media,
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
		...(importProjectId ? { importProjectId } : {}),
		...(clips ? { clips, schemaVersion: 2 as const } : {}),
	};
}

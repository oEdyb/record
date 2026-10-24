import {
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
} from "@/components/video-editor/editorDefaults";
import type { ExportFormat, ExportQuality } from "@/lib/exporter";
import { type AspectRatio, isAspectRatio } from "@/utils/aspectRatioUtils";

const PREFS_KEY = "openscreen_user_preferences";

export interface UserPreferences {
	/** Default padding % */
	padding: number;
	/** Default aspect ratio */
	aspectRatio: AspectRatio;
	/** Default export quality */
	exportQuality: ExportQuality;
	/** Default export format */
	exportFormat: ExportFormat;
	/** Folder used for the most recent successful export, if any */
	exportFolder: string | null;
	/** Folder of the most recently opened project, if any */
	projectFolder: string | null;
	/** Recording HUD control layout */
	trayLayout: "horizontal" | "vertical";
	/** Idle recording pill folded down to the mark and Record */
	hudMinimized: boolean;
	/** Last native screen position of the recording-mode webcam confidence monitor */
	cameraPreviewPosition: { x: number; y: number } | null;
	/** Last compact window size of the webcam confidence monitor; never camera layout */
	cameraPreviewSize: { width: number; height: number } | null;
	/** Keep the webcam confidence monitor off screen while the camera still records */
	cameraMonitorHidden: boolean;
	/** Private notes window frame in screen coordinates; never project content. */
	notesWindowBounds: { x: number; y: number; width: number; height: number } | null;
	/** Whether the AI editor sidebar was open when the user last changed it */
	editorChatOpen: boolean;
	/** Force the Windows native recorder to use the software H.264 encoder */
	preferSoftwareEncoder: boolean;
	/** Stop showing the notice that recording fell back to software encoding */
	hideSoftwareEncoderFallbackNotice: boolean;
	/** Editor preview listening level, 0..1; export audio ignores it */
	previewVolume: number;
	/** Editor preview muted; export audio ignores it */
	previewMuted: boolean;
}

export const DEFAULT_PREFS: UserPreferences = {
	padding: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
	aspectRatio: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
	exportQuality: DEFAULT_EXPORT_SETTINGS.quality,
	exportFormat: DEFAULT_EXPORT_SETTINGS.format,
	exportFolder: null,
	projectFolder: null,
	trayLayout: "horizontal",
	hudMinimized: false,
	cameraPreviewPosition: null,
	cameraPreviewSize: null,
	cameraMonitorHidden: false,
	notesWindowBounds: null,
	editorChatOpen: false,
	preferSoftwareEncoder: false,
	hideSoftwareEncoderFallbackNotice: false,
	previewVolume: 1,
	previewMuted: false,
};

/** Parses stored preferences without throwing on malformed JSON. */
function safeJsonParse(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Load preferences from localStorage, falling back to defaults for missing or invalid fields. */
function parseNotesWindowBounds(
	value: unknown,
): { x: number; y: number; width: number; height: number } | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const numbers = ["x", "y", "width", "height"].map((key) => candidate[key]);
	if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
	const [x, y, width, height] = numbers as number[];
	if (width <= 0 || height <= 0) return null;
	return {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.round(width),
		height: Math.round(height),
	};
}

function parseCameraPreviewSize(value: unknown): { width: number; height: number } | null {
	if (!value || typeof value !== "object") return null;
	const { width, height } = value as Record<string, unknown>;
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
	if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
	return { width: Math.round(width), height: Math.round(height) };
}

export function loadUserPreferences(): UserPreferences {
	let raw: Record<string, unknown> | null = null;
	try {
		raw = safeJsonParse(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_PREFS };
	}
	if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };

	return {
		padding:
			typeof raw.padding === "number" &&
			Number.isFinite(raw.padding) &&
			raw.padding >= 0 &&
			raw.padding <= 100
				? raw.padding
				: DEFAULT_PREFS.padding,
		aspectRatio: isAspectRatio(raw.aspectRatio) ? raw.aspectRatio : DEFAULT_PREFS.aspectRatio,
		exportQuality:
			raw.exportQuality === "medium" ||
			raw.exportQuality === "good" ||
			raw.exportQuality === "source"
				? (raw.exportQuality as ExportQuality)
				: DEFAULT_PREFS.exportQuality,
		exportFormat:
			raw.exportFormat === "gif" || raw.exportFormat === "mp4"
				? (raw.exportFormat as ExportFormat)
				: DEFAULT_PREFS.exportFormat,
		exportFolder:
			typeof raw.exportFolder === "string" && raw.exportFolder.length > 0
				? raw.exportFolder
				: DEFAULT_PREFS.exportFolder,
		projectFolder:
			typeof raw.projectFolder === "string" && raw.projectFolder.length > 0
				? raw.projectFolder
				: DEFAULT_PREFS.projectFolder,
		trayLayout:
			raw.trayLayout === "horizontal" || raw.trayLayout === "vertical"
				? raw.trayLayout
				: DEFAULT_PREFS.trayLayout,
		hudMinimized:
			typeof raw.hudMinimized === "boolean" ? raw.hudMinimized : DEFAULT_PREFS.hudMinimized,
		cameraPreviewPosition:
			raw.cameraPreviewPosition &&
			typeof raw.cameraPreviewPosition === "object" &&
			typeof (raw.cameraPreviewPosition as Record<string, unknown>).x === "number" &&
			Number.isFinite((raw.cameraPreviewPosition as Record<string, unknown>).x) &&
			typeof (raw.cameraPreviewPosition as Record<string, unknown>).y === "number" &&
			Number.isFinite((raw.cameraPreviewPosition as Record<string, unknown>).y)
				? {
						x: Math.round((raw.cameraPreviewPosition as Record<string, number>).x),
						y: Math.round((raw.cameraPreviewPosition as Record<string, number>).y),
					}
				: DEFAULT_PREFS.cameraPreviewPosition,
		cameraPreviewSize: parseCameraPreviewSize(raw.cameraPreviewSize),
		cameraMonitorHidden:
			typeof raw.cameraMonitorHidden === "boolean"
				? raw.cameraMonitorHidden
				: DEFAULT_PREFS.cameraMonitorHidden,
		notesWindowBounds: parseNotesWindowBounds(raw.notesWindowBounds),
		editorChatOpen:
			typeof raw.editorChatOpen === "boolean" ? raw.editorChatOpen : DEFAULT_PREFS.editorChatOpen,
		preferSoftwareEncoder:
			typeof raw.preferSoftwareEncoder === "boolean"
				? raw.preferSoftwareEncoder
				: DEFAULT_PREFS.preferSoftwareEncoder,
		hideSoftwareEncoderFallbackNotice:
			typeof raw.hideSoftwareEncoderFallbackNotice === "boolean"
				? raw.hideSoftwareEncoderFallbackNotice
				: DEFAULT_PREFS.hideSoftwareEncoderFallbackNotice,
		previewVolume:
			typeof raw.previewVolume === "number" &&
			Number.isFinite(raw.previewVolume) &&
			raw.previewVolume >= 0 &&
			raw.previewVolume <= 1
				? raw.previewVolume
				: DEFAULT_PREFS.previewVolume,
		previewMuted:
			typeof raw.previewMuted === "boolean" ? raw.previewMuted : DEFAULT_PREFS.previewMuted,
	};
}

/**
 * Parent directory of a saved file path. Handles both POSIX and Windows
 * separators since the path comes from the OS save dialog. Root dirs keep their
 * trailing separator so the result stays a valid directory ("/video.mp4" -> "/",
 * "C:\\video.mp4" -> "C:\\"). Returns null if no separator is found.
 */
export function parentDirectoryOf(filePath: string): string | null {
	const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (lastSep < 0) return null;

	// POSIX root, e.g. "/video.mp4" -> "/"
	if (lastSep === 0) return filePath[0];

	// Windows drive root, e.g. "C:\\video.mp4" -> "C:\\"
	if (lastSep === 2 && /^[A-Za-z]:[/\\]/.test(filePath)) {
		return filePath.slice(0, lastSep + 1);
	}

	return filePath.slice(0, lastSep);
}

/** Remembered open-project folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getProjectFolder(): string | undefined {
	return loadUserPreferences().projectFolder ?? undefined;
}

/** Persist preferences to localStorage; only the provided fields are updated. */
export function saveUserPreferences(partial: Partial<UserPreferences>): void {
	const current = loadUserPreferences();
	const merged = { ...current, ...partial };
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
	} catch {
		// localStorage may be unavailable (e.g. private browsing, quota exceeded)
	}
}

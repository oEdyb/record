import { MAX_WEBCAM_SIZE_PERCENT, MIN_WEBCAM_SIZE_PERCENT } from "@/lib/compositeLayout";
import { normalizeCursorThemeId } from "@/lib/cursor/cursorThemes";
import type {
	ExportFormat,
	ExportQuality,
	ExportVideoCodec,
	GifFrameRate,
	GifSizePreset,
} from "@/lib/exporter";
import { isAspectRatio } from "@/utils/aspectRatioUtils";
import {
	type CaptionSettings,
	DEFAULT_CAPTION_SETTINGS,
	normalizeCaptionSettings,
	patchCaptionSettings,
} from "../captions";
import type { AxcutDocument } from "../schema";
import {
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsPatch,
	type EditorSettingsSnapshot,
	patchEditorSettings,
} from "./editorSettings";

const STORAGE_KEY = "screenrec.editing-preferences:v1";
const LEGACY_USER_PREFERENCES_KEY = "openscreen_user_preferences";
const LEGACY_NORMALIZE_VOLUME_KEY = "screenrec.export.normalizeVolume";

interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export type EditorDefaultPreferences = Omit<EditorSettingsSnapshot, "cropRegion">;
export type CaptionDefaultPreferences = Omit<CaptionSettings, "language">;

export interface ExportPreferences {
	format: ExportFormat;
	quality: ExportQuality;
	fps: 24 | 30 | 60;
	codec: Extract<ExportVideoCodec, "h264" | "h265">;
	normalizeVolume: boolean;
	gifFrameRate: GifFrameRate;
	gifSize: GifSizePreset;
	gifLoop: boolean;
}

export interface EditingPreferences {
	version: 1;
	editor: EditorDefaultPreferences;
	captions: CaptionDefaultPreferences;
	export: ExportPreferences;
}

export const DEFAULT_EXPORT_PREFERENCES: ExportPreferences = {
	format: "mp4",
	quality: "good",
	fps: 60,
	codec: "h264",
	normalizeVolume: true,
	gifFrameRate: 15,
	gifSize: "medium",
	gifLoop: true,
};

function cloneEditorDefaults(): EditorDefaultPreferences {
	const { cropRegion: _cropRegion, ...defaults } = DEFAULT_EDITOR_SETTINGS;
	return {
		...defaults,
		webcamPosition: defaults.webcamPosition ? { ...defaults.webcamPosition } : null,
		cursor: { ...defaults.cursor },
	};
}

function cloneCaptionDefaults(): CaptionDefaultPreferences {
	const { language: _language, ...defaults } = DEFAULT_CAPTION_SETTINGS;
	return { ...defaults };
}

function readRecord(storage: PreferenceStorage, key: string): Record<string, unknown> | null {
	try {
		const value = storage.getItem(key);
		if (!value) return null;
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
		? value
		: fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function isReusableWallpaper(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 16_384 &&
		!value.startsWith("data:") &&
		!value.startsWith("blob:")
	);
}

function normalizeEditorDefaults(
	value: unknown,
	legacy: Record<string, unknown> | null,
): EditorDefaultPreferences {
	const raw = record(value);
	const defaults = cloneEditorDefaults();
	const cursor = record(raw?.cursor);
	const position = record(raw?.webcamPosition);
	const legacyAspect = isAspectRatio(legacy?.aspectRatio)
		? legacy.aspectRatio
		: defaults.aspectRatio;
	const legacyPadding = numberInRange(legacy?.padding, defaults.padding, 0, 100);

	const layout = raw?.webcamLayoutPreset;
	const mask = raw?.webcamMaskShape;
	return {
		wallpaper: isReusableWallpaper(raw?.wallpaper) ? raw.wallpaper : defaults.wallpaper,
		aspectRatio: isAspectRatio(raw?.aspectRatio) ? raw.aspectRatio : legacyAspect,
		shadowIntensity: numberInRange(raw?.shadowIntensity, defaults.shadowIntensity, 0, 1),
		showBlur: booleanOr(raw?.showBlur, defaults.showBlur),
		motionBlurAmount: numberInRange(raw?.motionBlurAmount, defaults.motionBlurAmount, 0, 1),
		borderRadius: numberInRange(raw?.borderRadius, defaults.borderRadius, 0, 64),
		padding: numberInRange(raw?.padding, legacyPadding, 0, 100),
		webcamLayoutPreset:
			layout === "picture-in-picture" ||
			layout === "vertical-stack" ||
			layout === "dual-frame" ||
			layout === "no-webcam"
				? layout
				: defaults.webcamLayoutPreset,
		webcamMaskShape:
			mask === "rectangle" || mask === "circle" || mask === "square" || mask === "rounded"
				? mask
				: defaults.webcamMaskShape,
		webcamMirrored: booleanOr(raw?.webcamMirrored, defaults.webcamMirrored),
		webcamReactiveZoom: booleanOr(raw?.webcamReactiveZoom, defaults.webcamReactiveZoom),
		webcamSizePreset: numberInRange(
			raw?.webcamSizePreset,
			defaults.webcamSizePreset,
			MIN_WEBCAM_SIZE_PERCENT,
			MAX_WEBCAM_SIZE_PERCENT,
		),
		webcamPosition:
			typeof position?.cx === "number" &&
			Number.isFinite(position.cx) &&
			position.cx >= 0 &&
			position.cx <= 1 &&
			typeof position.cy === "number" &&
			Number.isFinite(position.cy) &&
			position.cy >= 0 &&
			position.cy <= 1
				? { cx: position.cx, cy: position.cy }
				: null,
		cursor: {
			size: numberInRange(cursor?.size, defaults.cursor.size, 0.5, 10),
			smoothing: numberInRange(cursor?.smoothing, defaults.cursor.smoothing, 0, 1),
			motionBlur: numberInRange(cursor?.motionBlur, defaults.cursor.motionBlur, 0, 1),
			clickBounce: numberInRange(cursor?.clickBounce, defaults.cursor.clickBounce, 0, 5),
			clipToBounds: booleanOr(cursor?.clipToBounds, defaults.cursor.clipToBounds),
		},
		cursorShow: booleanOr(raw?.cursorShow, defaults.cursorShow),
		cursorTheme: normalizeCursorThemeId(raw?.cursorTheme),
		autoFocusAll: booleanOr(raw?.autoFocusAll, defaults.autoFocusAll),
	};
}

function normalizeExportPreferences(
	value: unknown,
	legacy: Record<string, unknown> | null,
	legacyNormalizeVolume: boolean,
): ExportPreferences {
	const raw = record(value);
	const format = raw?.format ?? legacy?.exportFormat;
	const quality = raw?.quality ?? legacy?.exportQuality;
	return {
		format: format === "gif" || format === "mp4" ? format : DEFAULT_EXPORT_PREFERENCES.format,
		quality:
			quality === "medium" || quality === "good" || quality === "source"
				? quality
				: DEFAULT_EXPORT_PREFERENCES.quality,
		fps: raw?.fps === 24 || raw?.fps === 30 || raw?.fps === 60 ? raw.fps : 60,
		codec: raw?.codec === "h265" ? "h265" : "h264",
		normalizeVolume: booleanOr(raw?.normalizeVolume, legacyNormalizeVolume),
		gifFrameRate:
			raw?.gifFrameRate === 15 ||
			raw?.gifFrameRate === 20 ||
			raw?.gifFrameRate === 25 ||
			raw?.gifFrameRate === 30
				? raw.gifFrameRate
				: DEFAULT_EXPORT_PREFERENCES.gifFrameRate,
		gifSize:
			raw?.gifSize === "medium" || raw?.gifSize === "large" || raw?.gifSize === "original"
				? raw.gifSize
				: DEFAULT_EXPORT_PREFERENCES.gifSize,
		gifLoop: booleanOr(raw?.gifLoop, DEFAULT_EXPORT_PREFERENCES.gifLoop),
	};
}

function normalizeCaptionDefaults(value: unknown): CaptionDefaultPreferences {
	const normalized = normalizeCaptionSettings({
		...cloneCaptionDefaults(),
		...(record(value) ?? {}),
		language: null,
	});
	const { language: _language, ...captions } = normalized;
	return captions;
}

function readLegacyNormalizeVolume(storage: PreferenceStorage): boolean {
	try {
		return storage.getItem(LEGACY_NORMALIZE_VOLUME_KEY) !== "false";
	} catch {
		return DEFAULT_EXPORT_PREFERENCES.normalizeVolume;
	}
}

export function loadEditingPreferences(
	storage: PreferenceStorage = localStorage,
): EditingPreferences {
	const saved = readRecord(storage, STORAGE_KEY);
	const legacy = readRecord(storage, LEGACY_USER_PREFERENCES_KEY);
	const isCurrent = saved?.version === 1;
	return {
		version: 1,
		editor: normalizeEditorDefaults(isCurrent ? saved.editor : null, legacy),
		captions: normalizeCaptionDefaults(isCurrent ? saved.captions : null),
		export: normalizeExportPreferences(
			isCurrent ? saved.export : null,
			legacy,
			readLegacyNormalizeVolume(storage),
		),
	};
}

function writeEditingPreferences(
	preferences: EditingPreferences,
	storage: PreferenceStorage,
): boolean {
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
		return true;
	} catch {
		return false;
	}
}

export function saveEditorDefaultPreferences(
	settings: EditorSettingsSnapshot,
	storage: PreferenceStorage = localStorage,
): boolean {
	const current = loadEditingPreferences(storage);
	const { cropRegion: _cropRegion, ...editor } = settings;
	return writeEditingPreferences(
		{
			...current,
			editor: normalizeEditorDefaults(
				{
					...editor,
					wallpaper: isReusableWallpaper(editor.wallpaper)
						? editor.wallpaper
						: current.editor.wallpaper,
				},
				null,
			),
		},
		storage,
	);
}

export function saveCaptionDefaultPreferences(
	settings: CaptionSettings,
	storage: PreferenceStorage = localStorage,
): boolean {
	const current = loadEditingPreferences(storage);
	const { language: _language, ...captions } = settings;
	return writeEditingPreferences(
		{
			...current,
			captions: normalizeCaptionDefaults(captions),
		},
		storage,
	);
}

export function saveExportPreferences(
	patch: Partial<ExportPreferences>,
	storage: PreferenceStorage = localStorage,
): boolean {
	const current = loadEditingPreferences(storage);
	return writeEditingPreferences(
		{
			...current,
			export: normalizeExportPreferences(
				{ ...current.export, ...patch },
				null,
				current.export.normalizeVolume,
			),
		},
		storage,
	);
}

export function editorDefaultPreferencesToPatch(
	preferences: EditorDefaultPreferences,
): EditorSettingsPatch {
	return {
		wallpaper: preferences.wallpaper,
		aspectRatio: preferences.aspectRatio,
		shadowIntensity: preferences.shadowIntensity,
		showBlur: preferences.showBlur,
		motionBlurAmount: preferences.motionBlurAmount,
		borderRadius: preferences.borderRadius,
		padding: preferences.padding,
		webcamLayoutPreset: preferences.webcamLayoutPreset,
		webcamMaskShape: preferences.webcamMaskShape,
		webcamMirrored: preferences.webcamMirrored,
		webcamReactiveZoom: preferences.webcamReactiveZoom,
		webcamSizePreset: preferences.webcamSizePreset,
		webcamPosition: preferences.webcamPosition,
		cursor: {
			...preferences.cursor,
			show: preferences.cursorShow,
			theme: preferences.cursorTheme,
		},
		autoFocusAll: preferences.autoFocusAll,
	};
}

export function applyEditorDefaultPreferences(
	document: AxcutDocument,
	preferences: EditorDefaultPreferences,
): AxcutDocument {
	return patchEditorSettings(document, editorDefaultPreferencesToPatch(preferences));
}

export function applyEditingDefaultPreferences(
	document: AxcutDocument,
	preferences: EditingPreferences,
): AxcutDocument {
	const withEditorDefaults = applyEditorDefaultPreferences(document, preferences.editor);
	return patchCaptionSettings(withEditorDefaults, {
		...preferences.captions,
		language: null,
	});
}

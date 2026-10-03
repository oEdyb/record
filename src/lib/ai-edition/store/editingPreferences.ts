import {
	MAX_WEBCAM_ZOOM,
	MIN_WEBCAM_ZOOM,
	normalizeWebcamAspectRatio,
	normalizeWebcamCornerRadius,
} from "@/components/video-editor/types";
import { normalizeOutputResolution } from "@/lib/ai-edition/document/outputFormat";
import {
	MAX_WEBCAM_BLOCK_CAMERA_SHARE,
	MAX_WEBCAM_SIZE_PERCENT,
	MIN_WEBCAM_BLOCK_CAMERA_SHARE,
	MIN_WEBCAM_SIZE_PERCENT,
} from "@/lib/compositeLayout";
import { normalizeCursorThemeId } from "@/lib/cursor/cursorThemes";
import type {
	ExportFormat,
	ExportQuality,
	ExportVideoCodec,
	GifFrameRate,
	GifSizePreset,
} from "@/lib/exporter";
import { normalizeScreenFramingByVariant } from "@/lib/screenFraming";
import { isAspectRatio } from "@/utils/aspectRatioUtils";
import {
	type CaptionSettings,
	DEFAULT_CAPTION_SETTINGS,
	normalizeCaptionSettings,
	patchCaptionSettings,
} from "../captions";
import type { AxcutDocument } from "../schema";
import {
	DEFAULT_AUDIO_PEAK_CEILING_DBTP,
	DEFAULT_AUDIO_TARGET_LUFS,
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsPatch,
	type EditorSettingsSnapshot,
	MAX_AUDIO_PEAK_CEILING_DBTP,
	MAX_AUDIO_TARGET_LUFS,
	MAX_SOURCE_VOLUME,
	MIN_AUDIO_PEAK_CEILING_DBTP,
	MIN_AUDIO_TARGET_LUFS,
	MIN_SOURCE_VOLUME,
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
		outputResolution: defaults.outputResolution ? { ...defaults.outputResolution } : null,
		screenFramingByVariant: normalizeScreenFramingByVariant(defaults.screenFramingByVariant),
		webcamPosition: defaults.webcamPosition ? { ...defaults.webcamPosition } : null,
		webcamFocalPoint: { ...defaults.webcamFocalPoint },
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
	legacyNormalizeVolume = DEFAULT_EDITOR_SETTINGS.normalizeVolume,
): EditorDefaultPreferences {
	const raw = record(value);
	const defaults = cloneEditorDefaults();
	const cursor = record(raw?.cursor);
	const position = record(raw?.webcamPosition);
	const focalPoint = record(raw?.webcamFocalPoint);
	const legacyAspect = isAspectRatio(legacy?.aspectRatio)
		? legacy.aspectRatio
		: defaults.aspectRatio;
	const legacyPadding = numberInRange(legacy?.padding, defaults.padding, 0, 100);

	const layout = raw?.webcamLayoutPreset;
	const mask = raw?.webcamMaskShape;
	const audioDeliveryPreset = raw?.audioDeliveryPreset === "custom" ? "custom" : "youtube";
	return {
		wallpaper: isReusableWallpaper(raw?.wallpaper) ? raw.wallpaper : defaults.wallpaper,
		aspectRatio: isAspectRatio(raw?.aspectRatio) ? raw.aspectRatio : legacyAspect,
		outputResolution: normalizeOutputResolution(raw?.outputResolution),
		screenFramingByVariant: normalizeScreenFramingByVariant(raw?.screenFramingByVariant),
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
		webcamBlockOrder: raw?.webcamBlockOrder === "camera-first" ? "camera-first" : "screen-first",
		webcamBlockCameraShare: numberInRange(
			raw?.webcamBlockCameraShare,
			defaults.webcamBlockCameraShare,
			MIN_WEBCAM_BLOCK_CAMERA_SHARE,
			MAX_WEBCAM_BLOCK_CAMERA_SHARE,
		),
		webcamMaskShape:
			mask === "rectangle" ||
			mask === "circle" ||
			mask === "square" ||
			mask === "rounded" ||
			mask === "squircle"
				? mask
				: defaults.webcamMaskShape,
		webcamCornerRadius: normalizeWebcamCornerRadius(raw?.webcamCornerRadius),
		webcamAspectRatio: normalizeWebcamAspectRatio(raw?.webcamAspectRatio),
		webcamMirrored: booleanOr(raw?.webcamMirrored, defaults.webcamMirrored),
		webcamReactiveZoom: booleanOr(raw?.webcamReactiveZoom, defaults.webcamReactiveZoom),
		webcamSizePreset: numberInRange(
			raw?.webcamSizePreset,
			defaults.webcamSizePreset,
			MIN_WEBCAM_SIZE_PERCENT,
			MAX_WEBCAM_SIZE_PERCENT,
		),
		webcamZoom: numberInRange(
			raw?.webcamZoom,
			defaults.webcamZoom,
			MIN_WEBCAM_ZOOM,
			MAX_WEBCAM_ZOOM,
		),
		webcamFocalPoint:
			typeof focalPoint?.cx === "number" &&
			Number.isFinite(focalPoint.cx) &&
			typeof focalPoint.cy === "number" &&
			Number.isFinite(focalPoint.cy)
				? {
						cx: Math.min(1, Math.max(0, focalPoint.cx)),
						cy: Math.min(1, Math.max(0, focalPoint.cy)),
					}
				: { ...defaults.webcamFocalPoint },
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
		microphoneVolume: numberInRange(
			raw?.microphoneVolume,
			defaults.microphoneVolume,
			MIN_SOURCE_VOLUME,
			MAX_SOURCE_VOLUME,
		),
		microphoneMuted: booleanOr(raw?.microphoneMuted, defaults.microphoneMuted),
		systemAudioVolume: numberInRange(
			raw?.systemAudioVolume,
			defaults.systemAudioVolume,
			MIN_SOURCE_VOLUME,
			MAX_SOURCE_VOLUME,
		),
		systemAudioMuted: booleanOr(raw?.systemAudioMuted, defaults.systemAudioMuted),
		evenVolume: booleanOr(raw?.evenVolume, defaults.evenVolume),
		normalizeVolume: booleanOr(raw?.normalizeVolume, legacyNormalizeVolume),
		audioDeliveryPreset,
		audioTargetLufs:
			audioDeliveryPreset === "youtube"
				? DEFAULT_AUDIO_TARGET_LUFS
				: numberInRange(
						raw?.audioTargetLufs,
						DEFAULT_AUDIO_TARGET_LUFS,
						MIN_AUDIO_TARGET_LUFS,
						MAX_AUDIO_TARGET_LUFS,
					),
		audioPeakCeilingDbtp:
			audioDeliveryPreset === "youtube"
				? DEFAULT_AUDIO_PEAK_CEILING_DBTP
				: numberInRange(
						raw?.audioPeakCeilingDbtp,
						DEFAULT_AUDIO_PEAK_CEILING_DBTP,
						MIN_AUDIO_PEAK_CEILING_DBTP,
						MAX_AUDIO_PEAK_CEILING_DBTP,
					),
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
	const exportPreferences = normalizeExportPreferences(
		isCurrent ? saved.export : null,
		legacy,
		readLegacyNormalizeVolume(storage),
	);
	return {
		version: 1,
		editor: normalizeEditorDefaults(
			isCurrent ? saved.editor : null,
			legacy,
			exportPreferences.normalizeVolume,
		),
		captions: normalizeCaptionDefaults(isCurrent ? saved.captions : null),
		export: exportPreferences,
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
		outputResolution: preferences.outputResolution,
		screenFramingByVariant: preferences.screenFramingByVariant,
		shadowIntensity: preferences.shadowIntensity,
		showBlur: preferences.showBlur,
		motionBlurAmount: preferences.motionBlurAmount,
		borderRadius: preferences.borderRadius,
		padding: preferences.padding,
		webcamLayoutPreset: preferences.webcamLayoutPreset,
		webcamBlockOrder: preferences.webcamBlockOrder,
		webcamBlockCameraShare: preferences.webcamBlockCameraShare,
		webcamMaskShape: preferences.webcamMaskShape,
		webcamCornerRadius: preferences.webcamCornerRadius,
		webcamAspectRatio: preferences.webcamAspectRatio,
		webcamMirrored: preferences.webcamMirrored,
		webcamReactiveZoom: preferences.webcamReactiveZoom,
		webcamSizePreset: preferences.webcamSizePreset,
		webcamZoom: preferences.webcamZoom,
		webcamFocalPoint: preferences.webcamFocalPoint,
		webcamPosition: preferences.webcamPosition,
		cursor: {
			...preferences.cursor,
			show: preferences.cursorShow,
			theme: preferences.cursorTheme,
		},
		autoFocusAll: preferences.autoFocusAll,
		microphoneVolume: preferences.microphoneVolume,
		microphoneMuted: preferences.microphoneMuted,
		systemAudioVolume: preferences.systemAudioVolume,
		systemAudioMuted: preferences.systemAudioMuted,
		evenVolume: preferences.evenVolume,
		normalizeVolume: preferences.normalizeVolume,
		audioDeliveryPreset: preferences.audioDeliveryPreset,
		audioTargetLufs: preferences.audioTargetLufs,
		audioPeakCeilingDbtp: preferences.audioPeakCeilingDbtp,
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

export function applyNewProjectPreferences(
	document: AxcutDocument,
	preferences: EditingPreferences,
): AxcutDocument {
	const plain = patchEditorSettings(applyEditingDefaultPreferences(document, preferences), {
		aspectRatio: DEFAULT_EDITOR_SETTINGS.aspectRatio,
		padding: 0,
		borderRadius: 0,
		shadowIntensity: 0,
		showBlur: false,
		motionBlurAmount: 0,
		outputResolution: null,
		screenFramingByVariant: {},
		autoFocusAll: false,
		webcamReactiveZoom: false,
		webcamZoom: 1,
		microphoneVolume: 1,
		microphoneMuted: false,
		systemAudioVolume: 1,
		systemAudioMuted: false,
		evenVolume: false,
		normalizeVolume: false,
		cursor: { size: 1, smoothing: 0, motionBlur: 0, clickBounce: 0 },
	});
	return patchCaptionSettings(plain, { enabled: false });
}

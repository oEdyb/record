import { describe, expect, it } from "vitest";
import { DEFAULT_CROP_REGION } from "@/components/video-editor/types";
import { DEFAULT_CAPTION_SETTINGS, getCaptionSettings } from "../captions";
import { createEmptyDocument } from "../schema";
import {
	applyEditingDefaultPreferences,
	applyEditorDefaultPreferences,
	loadEditingPreferences,
	saveCaptionDefaultPreferences,
	saveEditorDefaultPreferences,
	saveExportPreferences,
} from "./editingPreferences";
import { DEFAULT_EDITOR_SETTINGS, getEditorSettings } from "./editorSettings";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

describe("editing preferences", () => {
	it("uses safe defaults when no preferences exist", () => {
		const preferences = loadEditingPreferences(memoryStorage());

		expect(preferences.version).toBe(1);
		expect(preferences.editor.padding).toBe(DEFAULT_EDITOR_SETTINGS.padding);
		expect(preferences.editor.cursor).toEqual(DEFAULT_EDITOR_SETTINGS.cursor);
		expect(preferences.editor).toMatchObject({
			microphoneVolume: 1,
			microphoneMuted: false,
			systemAudioVolume: 1,
			systemAudioMuted: false,
			evenVolume: true,
			normalizeVolume: true,
			audioDeliveryPreset: "youtube",
			audioTargetLufs: -14.5,
			audioPeakCeilingDbtp: -2,
		});
		expect(preferences.export).toMatchObject({
			format: "mp4",
			quality: "good",
			fps: 60,
			codec: "h264",
			normalizeVolume: true,
		});
	});

	it("migrates the existing layout, export, and volume choices", () => {
		const storage = memoryStorage();
		storage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({
				padding: 28,
				aspectRatio: "9:16",
				exportFormat: "gif",
				exportQuality: "source",
			}),
		);
		storage.setItem("screenrec.export.normalizeVolume", "false");

		const preferences = loadEditingPreferences(storage);

		expect(preferences.editor.padding).toBe(28);
		expect(preferences.editor.aspectRatio).toBe("9:16");
		expect(preferences.export.format).toBe("gif");
		expect(preferences.export.quality).toBe("source");
		expect(preferences.export.normalizeVolume).toBe(false);
		expect(preferences.editor.normalizeVolume).toBe(false);
	});

	it("round-trips reusable editor controls without carrying a source crop", () => {
		const storage = memoryStorage();
		const settings = {
			...DEFAULT_EDITOR_SETTINGS,
			wallpaper: "linear-gradient(red, blue)",
			aspectRatio: "4:5" as const,
			outputResolution: { width: 1080, height: 1350 },
			padding: 23,
			showBlur: true,
			webcamLayoutPreset: "picture-in-picture" as const,
			webcamBlockOrder: "camera-first" as const,
			webcamBlockCameraShare: 62,
			webcamMaskShape: "circle" as const,
			webcamFocalPoint: { cx: 0.15, cy: 0.7 },
			microphoneVolume: 0.8,
			microphoneMuted: false,
			systemAudioVolume: 0.35,
			systemAudioMuted: true,
			evenVolume: false,
			normalizeVolume: false,
			audioDeliveryPreset: "custom" as const,
			audioTargetLufs: -18,
			audioPeakCeilingDbtp: -3,
			webcamPosition: { cx: 0.2, cy: 0.8 },
			cursor: { ...DEFAULT_EDITOR_SETTINGS.cursor, size: 4.2, smoothing: 0.9 },
			cropRegion: { x: 0.25, y: 0.1, width: 0.5, height: 0.7 },
		};

		expect(saveEditorDefaultPreferences(settings, storage)).toBe(true);
		const saved = loadEditingPreferences(storage).editor;

		expect(saved).toMatchObject({
			wallpaper: "linear-gradient(red, blue)",
			aspectRatio: "4:5",
			outputResolution: { width: 1080, height: 1350 },
			padding: 23,
			showBlur: true,
			webcamMaskShape: "circle",
			webcamBlockOrder: "camera-first",
			webcamBlockCameraShare: 62,
			webcamFocalPoint: { cx: 0.15, cy: 0.7 },
			webcamPosition: { cx: 0.2, cy: 0.8 },
			cursor: { size: 4.2, smoothing: 0.9 },
			microphoneVolume: 0.8,
			microphoneMuted: false,
			systemAudioVolume: 0.35,
			systemAudioMuted: true,
			evenVolume: false,
			normalizeVolume: false,
			audioDeliveryPreset: "custom",
			audioTargetLufs: -18,
			audioPeakCeilingDbtp: -3,
		});
		expect(saved).not.toHaveProperty("cropRegion");
	});

	it("keeps uploaded backgrounds in the project without copying them into app preferences", () => {
		const storage = memoryStorage();
		saveEditorDefaultPreferences(
			{ ...DEFAULT_EDITOR_SETTINGS, wallpaper: "linear-gradient(red, blue)" },
			storage,
		);
		const uploadedWallpaper = `data:image/png;base64,${"a".repeat(100_000)}`;

		expect(
			saveEditorDefaultPreferences(
				{
					...DEFAULT_EDITOR_SETTINGS,
					wallpaper: uploadedWallpaper,
					padding: 29,
				},
				storage,
			),
		).toBe(true);

		const serialized = storage.getItem("screenrec.editing-preferences:v1");
		expect(serialized).not.toContain(uploadedWallpaper);
		expect(loadEditingPreferences(storage).editor).toMatchObject({
			wallpaper: "linear-gradient(red, blue)",
			padding: 29,
		});
		expect(saveExportPreferences({ fps: 24 }, storage)).toBe(true);
		expect(loadEditingPreferences(storage).export.fps).toBe(24);
	});

	it("fails safely when preference storage rejects a write", () => {
		const storage = {
			getItem: () => null,
			setItem: () => {
				throw new DOMException("Quota exceeded", "QuotaExceededError");
			},
		};

		expect(saveEditorDefaultPreferences(DEFAULT_EDITOR_SETTINGS, storage)).toBe(false);
		expect(loadEditingPreferences(storage).editor).toEqual(
			loadEditingPreferences(memoryStorage()).editor,
		);
	});

	it("remembers camera size, zoom, and focal point for the next project", () => {
		const storage = memoryStorage();
		saveEditorDefaultPreferences(
			{
				...DEFAULT_EDITOR_SETTINGS,
				webcamSizePreset: 70,
				webcamZoom: 1.85,
				webcamFocalPoint: { cx: 0.25, cy: 0.75 },
			},
			storage,
		);

		expect(loadEditingPreferences(storage).editor.webcamSizePreset).toBe(70);
		expect(loadEditingPreferences(storage).editor.webcamZoom).toBe(1.85);
		expect(loadEditingPreferences(storage).editor.webcamFocalPoint).toEqual({
			cx: 0.25,
			cy: 0.75,
		});
	});

	it("rejects malformed values one field at a time", () => {
		const storage = memoryStorage();
		storage.setItem(
			"screenrec.editing-preferences:v1",
			JSON.stringify({
				version: 1,
				editor: {
					padding: 400,
					aspectRatio: "wide",
					webcamSizePreset: "huge",
					webcamZoom: 9,
					webcamFocalPoint: { cx: -2, cy: 4 },
					audioDeliveryPreset: "broadcast",
					audioTargetLufs: -3,
					audioPeakCeilingDbtp: 0,
					microphoneVolume: 2,
					systemAudioVolume: -1,
					cursor: { size: -2, smoothing: 0.75 },
				},
				export: { fps: 120, codec: "vp9", gifFrameRate: 120 },
			}),
		);

		const preferences = loadEditingPreferences(storage);

		expect(preferences.editor.padding).toBe(DEFAULT_EDITOR_SETTINGS.padding);
		expect(preferences.editor.aspectRatio).toBe(DEFAULT_EDITOR_SETTINGS.aspectRatio);
		expect(preferences.editor.webcamSizePreset).toBe(DEFAULT_EDITOR_SETTINGS.webcamSizePreset);
		expect(preferences.editor.webcamZoom).toBe(DEFAULT_EDITOR_SETTINGS.webcamZoom);
		expect(preferences.editor.webcamFocalPoint).toEqual({ cx: 0, cy: 1 });
		expect(preferences.editor.cursor.size).toBe(DEFAULT_EDITOR_SETTINGS.cursor.size);
		expect(preferences.editor.cursor.smoothing).toBe(0.75);
		expect(preferences.editor.audioDeliveryPreset).toBe("youtube");
		expect(preferences.editor.audioTargetLufs).toBe(-14.5);
		expect(preferences.editor.audioPeakCeilingDbtp).toBe(-2);
		expect(preferences.editor.microphoneVolume).toBe(1);
		expect(preferences.editor.systemAudioVolume).toBe(1);
		expect(preferences.export.fps).toBe(60);
		expect(preferences.export.codec).toBe("h264");
		expect(preferences.export.gifFrameRate).toBe(15);
	});

	it("updates export choices without losing editor defaults", () => {
		const storage = memoryStorage();
		saveEditorDefaultPreferences({ ...DEFAULT_EDITOR_SETTINGS, padding: 31 }, storage);

		saveExportPreferences(
			{
				format: "gif",
				fps: 24,
				codec: "h265",
				gifFrameRate: 30,
				gifLoop: false,
			},
			storage,
		);

		const preferences = loadEditingPreferences(storage);
		expect(preferences.editor.padding).toBe(31);
		expect(preferences.export).toMatchObject({
			format: "gif",
			fps: 24,
			codec: "h265",
			gifFrameRate: 30,
			gifLoop: false,
		});
	});

	it("remembers reusable caption styling but not a project translation", () => {
		const storage = memoryStorage();
		saveCaptionDefaultPreferences(
			{
				...DEFAULT_CAPTION_SETTINGS,
				enabled: true,
				language: "fr",
				fontFamily: "Sora",
				fontSize: 64,
				verticalPosition: "top",
			},
			storage,
		);

		const preferences = loadEditingPreferences(storage);
		expect(preferences.captions).toMatchObject({
			enabled: true,
			fontFamily: "Sora",
			fontSize: 64,
			verticalPosition: "top",
		});
		expect(preferences.captions).not.toHaveProperty("language");

		const empty = createEmptyDocument({
			projectId: "captions",
			title: "Captions",
		});
		const seeded = applyEditingDefaultPreferences(empty, preferences);
		expect(getCaptionSettings(seeded)).toMatchObject({
			enabled: true,
			language: null,
			fontFamily: "Sora",
			fontSize: 64,
			verticalPosition: "top",
		});
	});

	it("seeds a new project with remembered controls and a neutral crop", () => {
		const storage = memoryStorage();
		saveEditorDefaultPreferences(
			{
				...DEFAULT_EDITOR_SETTINGS,
				padding: 19,
				webcamMirrored: true,
				cropRegion: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
			},
			storage,
		);
		const empty = createEmptyDocument({
			projectId: "project",
			title: "Project",
		});

		const seeded = applyEditorDefaultPreferences(empty, loadEditingPreferences(storage).editor);
		const settings = getEditorSettings(seeded);

		expect(settings.padding).toBe(19);
		expect(settings.webcamMirrored).toBe(true);
		expect(settings.cropRegion).toEqual(DEFAULT_CROP_REGION);
	});
});

import { describe, expect, it } from "vitest";
import {
	DEFAULT_CROP_REGION,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_WEBCAM_LAYOUT_PRESET,
	DEFAULT_WEBCAM_MASK_SHAPE,
} from "@/components/video-editor/types";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { DEFAULT_EDITOR_SETTINGS, getEditorSettings, patchEditorSettings } from "./editorSettings";

const baseDoc: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "p1",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "clip",
			originalPath: "/x.mp4",
			cameraTrack: null,
		},
	],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	transcripts: [],
	transcript: null,
	legacyEditor: null,
};

describe("getEditorSettings", () => {
	it("returns the defaults when the document has no legacyEditor", () => {
		const snap = getEditorSettings(baseDoc);
		expect(snap.wallpaper).toBe(DEFAULT_EDITOR_SETTINGS.wallpaper);
		expect(snap.aspectRatio).toBe("16:9");
		expect(snap.outputResolution).toBeNull();
		expect(snap.shadowIntensity).toBe(DEFAULT_EDITOR_SETTINGS.shadowIntensity);
		expect(snap.showBlur).toBe(false);
		expect(snap.webcamLayoutPreset).toBe(DEFAULT_WEBCAM_LAYOUT_PRESET);
		expect(snap.webcamBlockOrder).toBe("screen-first");
		expect(snap.webcamBlockCameraShare).toBe(50);
		expect(snap.webcamMaskShape).toBe(DEFAULT_WEBCAM_MASK_SHAPE);
		expect(snap.webcamZoom).toBe(1);
		expect(snap.webcamFocalPoint).toEqual({ cx: 0.5, cy: 0.5 });
		expect(snap.cursor.size).toBe(DEFAULT_CURSOR_SIZE);
		expect(snap.microphoneVolume).toBe(1);
		expect(snap.microphoneMuted).toBe(false);
		expect(snap.systemAudioVolume).toBe(1);
		expect(snap.systemAudioMuted).toBe(false);
		expect(snap.evenVolume).toBe(true);
		expect(snap.normalizeVolume).toBe(true);
		expect(snap.audioDeliveryPreset).toBe("youtube");
		expect(snap.audioTargetLufs).toBe(-14.5);
		expect(snap.audioPeakCeilingDbtp).toBe(-2);
	});

	it("returns the defaults when the document is null", () => {
		const snap = getEditorSettings(null);
		expect(snap).toEqual(DEFAULT_EDITOR_SETTINGS);
	});

	it("reads overrides from legacyEditor", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				wallpaper: "linear-gradient(red, blue)",
				aspectRatio: "9:16",
				outputResolution: { width: 1440, height: 2560 },
				shadowIntensity: 0.5,
				showBlur: true,
				webcamLayoutPreset: "side-by-side",
				webcamBlockOrder: "camera-first",
				webcamBlockCameraShare: 65,
				webcamMaskShape: "circle",
				webcamZoom: 1.75,
				webcamFocalPoint: { cx: 0.2, cy: 0.8 },
				cursorSize: 5,
				cursorSmoothing: 0.8,
				microphoneVolume: 0.75,
				microphoneMuted: true,
				systemAudioVolume: 0.35,
				systemAudioMuted: false,
				evenVolume: false,
				normalizeVolume: false,
				audioDeliveryPreset: "custom",
				audioTargetLufs: -18,
				audioPeakCeilingDbtp: -3,
			},
		};
		const snap = getEditorSettings(doc);
		expect(snap.wallpaper).toBe("linear-gradient(red, blue)");
		expect(snap.aspectRatio).toBe("9:16");
		expect(snap.outputResolution).toEqual({ width: 1440, height: 2560 });
		expect(snap.shadowIntensity).toBe(0.5);
		expect(snap.showBlur).toBe(true);
		expect(snap.webcamLayoutPreset).toBe("side-by-side");
		expect(snap.webcamBlockOrder).toBe("camera-first");
		expect(snap.webcamBlockCameraShare).toBe(65);
		expect(snap.webcamMaskShape).toBe("circle");
		expect(snap.webcamZoom).toBe(1.75);
		expect(snap.webcamFocalPoint).toEqual({ cx: 0.2, cy: 0.8 });
		expect(snap.cursor.size).toBe(5);
		expect(snap.cursor.smoothing).toBe(0.8);
		expect(snap.microphoneVolume).toBe(0.75);
		expect(snap.microphoneMuted).toBe(true);
		expect(snap.systemAudioVolume).toBe(0.35);
		expect(snap.systemAudioMuted).toBe(false);
		expect(snap.evenVolume).toBe(false);
		expect(snap.normalizeVolume).toBe(false);
		expect(snap.audioDeliveryPreset).toBe("custom");
		expect(snap.audioTargetLufs).toBe(-18);
		expect(snap.audioPeakCeilingDbtp).toBe(-3);
	});

	it("clamps camera zoom from saved projects", () => {
		expect(getEditorSettings({ ...baseDoc, legacyEditor: { webcamZoom: 0.2 } }).webcamZoom).toBe(1);
		expect(getEditorSettings({ ...baseDoc, legacyEditor: { webcamZoom: 8 } }).webcamZoom).toBe(3);
	});

	it("clamps the stacked camera share from saved projects", () => {
		expect(
			getEditorSettings({
				...baseDoc,
				legacyEditor: { webcamBlockCameraShare: 5 },
			}).webcamBlockCameraShare,
		).toBe(20);
		expect(
			getEditorSettings({
				...baseDoc,
				legacyEditor: { webcamBlockCameraShare: 95 },
			}).webcamBlockCameraShare,
		).toBe(80);
	});

	it("clamps the saved camera focal point", () => {
		const snap = getEditorSettings({
			...baseDoc,
			legacyEditor: { webcamFocalPoint: { cx: 1.7, cy: -0.4 } },
		});
		expect(snap.webcamFocalPoint).toEqual({ cx: 1, cy: 0 });
	});

	it("falls back to defaults for unknown or wrong-type values", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { showBlur: "not-a-bool" as unknown as boolean },
		};
		const snap = getEditorSettings(doc);
		expect(snap.showBlur).toBe(false);
	});

	it("keeps the YouTube preset on its fixed mastering targets", () => {
		const snap = getEditorSettings({
			...baseDoc,
			legacyEditor: {
				audioDeliveryPreset: "youtube",
				audioTargetLufs: -18,
				audioPeakCeilingDbtp: -3,
			},
		});
		expect(snap.audioDeliveryPreset).toBe("youtube");
		expect(snap.audioTargetLufs).toBe(-14.5);
		expect(snap.audioPeakCeilingDbtp).toBe(-2);
	});

	it("rejects custom delivery targets outside the supported mastering range", () => {
		const snap = getEditorSettings({
			...baseDoc,
			legacyEditor: {
				audioDeliveryPreset: "custom",
				audioTargetLufs: -4,
				audioPeakCeilingDbtp: 0,
			},
		});
		expect(snap.audioDeliveryPreset).toBe("custom");
		expect(snap.audioTargetLufs).toBe(-14.5);
		expect(snap.audioPeakCeilingDbtp).toBe(-2);
	});
});

describe("patchEditorSettings", () => {
	it("writes a single field and leaves others intact", () => {
		const next = patchEditorSettings(baseDoc, { showBlur: true });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(DEFAULT_EDITOR_SETTINGS.shadowIntensity);
		expect(snap.cropRegion).toEqual(DEFAULT_CROP_REGION);
	});

	it("merges into an existing legacyEditor envelope", () => {
		const seed = patchEditorSettings(baseDoc, { showBlur: true });
		const next = patchEditorSettings(seed, { shadowIntensity: 0.7 });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(0.7);
	});

	it("treats an explicitly undefined key as absent, not as a clear", () => {
		const seed = patchEditorSettings(baseDoc, {
			showBlur: true,
			shadowIntensity: 0.7,
		});
		const next = patchEditorSettings(seed, {
			showBlur: undefined,
			padding: 12,
		});
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(0.7);
		expect(snap.padding).toBe(12);
	});

	it("patches nested cursor settings without clobbering siblings", () => {
		const seed = patchEditorSettings(baseDoc, { cursor: { size: 4 } });
		const next = patchEditorSettings(seed, { cursor: { smoothing: 0.9 } });
		const snap = getEditorSettings(next);
		expect(snap.cursor.size).toBe(4);
		expect(snap.cursor.smoothing).toBe(0.9);
	});

	it("round-trips independent audio delivery settings", () => {
		const next = patchEditorSettings(baseDoc, {
			microphoneVolume: 0.8,
			microphoneMuted: false,
			systemAudioVolume: 0.25,
			systemAudioMuted: true,
			evenVolume: false,
			normalizeVolume: true,
			audioDeliveryPreset: "custom",
			audioTargetLufs: -16,
			audioPeakCeilingDbtp: -1.5,
		});
		expect(getEditorSettings(next)).toMatchObject({
			microphoneVolume: 0.8,
			microphoneMuted: false,
			systemAudioVolume: 0.25,
			systemAudioMuted: true,
			evenVolume: false,
			normalizeVolume: true,
			audioDeliveryPreset: "custom",
			audioTargetLufs: -16,
			audioPeakCeilingDbtp: -1.5,
		});
	});

	it("rejects source volumes outside the supported range", () => {
		const snap = getEditorSettings({
			...baseDoc,
			legacyEditor: { microphoneVolume: 1.2, systemAudioVolume: -0.1 },
		});
		expect(snap.microphoneVolume).toBe(1);
		expect(snap.systemAudioVolume).toBe(1);
	});

	it("does not mutate the source document", () => {
		const before = getEditorSettings(baseDoc);
		patchEditorSettings(baseDoc, { showBlur: true });
		const after = getEditorSettings(baseDoc);
		expect(after).toEqual(before);
	});

	it("round-trips webcamPosition through legacyEditor", () => {
		const dragged = patchEditorSettings(baseDoc, {
			webcamPosition: { cx: 0.32, cy: 0.71 },
		});
		const snap = getEditorSettings(dragged);
		expect(snap.webcamPosition).toEqual({ cx: 0.32, cy: 0.71 });
	});

	it("clamps out-of-range webcamPosition when reading", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamPosition: { cx: 1.7, cy: -0.4 } },
		};
		const snap = getEditorSettings(doc);
		expect(snap.webcamPosition).toEqual({ cx: 1, cy: 0 });
	});

	it("round-trips and normalizes output-specific screen framing", () => {
		const patched = patchEditorSettings(baseDoc, {
			screenFramingByVariant: {
				"16:9": { scale: 1.25, focalPoint: { cx: 0.2, cy: 0.7 } },
				"9:16": { scale: 9, focalPoint: { cx: -1, cy: 2 } },
			},
		});
		expect(getEditorSettings(patched).screenFramingByVariant).toEqual({
			"16:9": { scale: 1.25, focalPoint: { cx: 0.2, cy: 0.7 } },
			"9:16": { scale: 4, focalPoint: { cx: 0, cy: 1 } },
		});
	});
});

it("persists camera rounding without changing legacy projects that omit it", () => {
	expect(getEditorSettings(baseDoc).webcamCornerRadius).toBeUndefined();
	const changed = patchEditorSettings(baseDoc, {
		webcamMaskShape: "squircle",
		webcamCornerRadius: 35,
		webcamAspectRatio: "4:3",
	});
	expect(getEditorSettings(JSON.parse(JSON.stringify(changed)))).toMatchObject({
		webcamMaskShape: "squircle",
		webcamCornerRadius: 35,
		webcamAspectRatio: "4:3",
	});
	for (const [input, output] of [
		[-1, 0],
		[100, 50],
		[NaN, undefined],
	] as const) {
		expect(
			getEditorSettings(patchEditorSettings(baseDoc, { webcamCornerRadius: input }))
				.webcamCornerRadius,
		).toBe(output);
	}
});

it("lets a direct camera drag replace an inherited named project anchor", () => {
	const anchored = patchEditorSettings(baseDoc, {
		cameraAnchor: "bottom-right",
		webcamPosition: { cx: 0.8, cy: 0.8 },
	});
	const dragged = patchEditorSettings(anchored, { webcamPosition: { cx: 0.2, cy: 0.3 } });
	expect(getEditorSettings(dragged).cameraAnchor).toBeUndefined();
	expect(getEditorSettings(dragged).webcamPosition).toEqual({ cx: 0.2, cy: 0.3 });
	expect(getEditorSettings(anchored).cameraAnchor).toBe("bottom-right");
	const reset = patchEditorSettings(anchored, { webcamPosition: null });
	expect(getEditorSettings(reset).cameraAnchor).toBeUndefined();
	expect(
		getEditorSettings(patchEditorSettings(anchored, { webcamSizePreset: 34 })).cameraAnchor,
	).toBe("bottom-right");
});

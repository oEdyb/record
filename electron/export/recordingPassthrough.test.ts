import { describe, expect, it } from "vitest";
import type { SceneDescription } from "../../src/native/sceneDescription";
import type { ClipInput, ExportParamsInput } from "../native/compositor-view/addon";
import { canPreserveRecordingSource } from "./recordingPassthrough";

const clip: ClipInput = {
	screenPath: "/recording.mp4",
	webcamPath: "",
	sourceStartSec: 0,
	sourceEndSec: 120,
	webcamOffsetSec: 0,
	hasAudio: true,
};
const params: ExportParamsInput = {
	width: 1920,
	height: 1080,
	fps: 60,
	codec: "h264",
	normalizeAudio: false,
	evenVolume: false,
	preserveRecordingSource: true,
};
function scene(): SceneDescription {
	return {
		clips: [{ ...clip }],
		layout: {
			preset: "no-webcam",
			webcamSize: 0.25,
			webcamZoom: 1,
			webcamFocalPoint: { cx: 0.5, cy: 0.5 },
			screenZoom: 1,
			screenFocalPoint: { cx: 0.5, cy: 0.5 },
			webcamShape: "rectangle",
			webcamMirror: false,
			webcamPosition: null,
			webcamReactiveZoom: false,
			webcamRect: null,
			screenRect: { x: 0, y: 0, width: 1, height: 1 },
			screenCover: false,
		},
		effects: { padding: 0, blur: false, shadow: 0, roundnessFrac: 0, motionBlur: 0 },
		background: { kind: "color", color: "#000000" },
		zoomRegions: [],
		annotations: [],
		cameraFullscreenRegions: [],
		speedRegions: [],
		cursor: {
			show: true,
			size: 1,
			smoothing: 0,
			motionBlur: 0,
			clickBounce: 0,
			clipToBounds: false,
			theme: "default",
		},
		cropByClip: [null],
		output: { width: 1920, height: 1080, fps: 60 },
	};
}
function eligible(
	value: SceneDescription = scene(),
	overrides: Partial<Parameters<typeof canPreserveRecordingSource>[0]> = {},
) {
	return canPreserveRecordingSource({
		clips: [clip],
		sceneJson: JSON.stringify(value),
		params,
		sourceDurationsSec: [120],
		hasCursorTrack: false,
		...overrides,
	});
}

describe("recording source preservation", () => {
	it("allows one complete source-shaped recording with its baked cursor", () => {
		expect(eligible()).toBe(true);
		const provisional = scene();
		provisional.clips[0]!.sourceEndSec = 120.001;
		expect(eligible(provisional)).toBe(true);
	});
	it.each([
		"padding",
		"shadow",
		"roundnessFrac",
		"motionBlur",
	] as const)("renders when %s changes pixels", (field) => {
		const value = scene();
		value.effects[field] = 0.1;
		expect(eligible(value)).toBe(false);
	});
	it.each([
		"zoomRegions",
		"annotations",
		"cameraFullscreenRegions",
		"speedRegions",
		"audioOverlays",
		"videoOverlays",
	] as const)("renders when %s is present", (field) => {
		const value = { ...scene(), [field]: [{ startSec: 0, endSec: 1 }] };
		expect(eligible(value as SceneDescription)).toBe(false);
	});
	it("retains ordinary bitrate and audio processing contracts", () => {
		for (const changed of [
			{ preserveRecordingSource: undefined },
			{ preserveRecordingSource: false },
			{ normalizeAudio: true },
			{ normalizeAudio: undefined },
			{ evenVolume: true },
			{ evenVolume: undefined },
			{ codec: "vp9" },
		]) {
			expect(eligible(scene(), { params: { ...params, ...changed } })).toBe(false);
		}
	});
	it("preserves source cadence only under explicit source-quality opt-in", () => {
		const value = scene();
		value.output.fps = 58;
		expect(eligible(value, { params: { ...params, fps: 60 } })).toBe(true);
		expect(eligible(value, { params: { ...params, fps: undefined } })).toBe(true);
		expect(
			eligible(value, { params: { ...params, fps: 60, preserveRecordingSource: false } }),
		).toBe(false);
	});
	it("renders trims, multiple takes, a camera, and cleaned microphone stems", () => {
		for (const changed of [
			{ sourceStartSec: 1 },
			{ sourceEndSec: 119 },
			{ webcamPath: "/camera.mp4" },
			{ cleanMicrophonePath: "/clean.wav" },
		]) {
			expect(eligible(scene(), { clips: [{ ...clip, ...changed }] })).toBe(false);
		}
		expect(eligible(scene(), { clips: [clip, clip] })).toBe(false);
	});
	it("joins complete takes split by Pause, and renders when any take is trimmed or framed", () => {
		const second = { ...clip, screenPath: "/recording-2.mp4", sourceEndSec: 45 };
		const joined = () => {
			const value = scene();
			value.clips = [{ ...clip }, { ...second }];
			value.cropByClip = [null, null];
			return value;
		};
		const takes = { clips: [clip, second], sourceDurationsSec: [120, 45] };
		expect(eligible(joined(), takes)).toBe(true);
		expect(eligible(joined(), { ...takes, sourceDurationsSec: [120, 46] })).toBe(false);
		expect(eligible(joined(), { ...takes, clips: [clip, { ...second, sourceStartSec: 2 }] })).toBe(
			false,
		);
		expect(
			eligible(joined(), { ...takes, clips: [clip, { ...second, webcamPath: "/camera.mov" }] }),
		).toBe(false);
		const cropped = joined();
		cropped.cropByClip = [null, { x: 0, y: 0, width: 0.5, height: 1 }];
		expect(eligible(cropped, takes)).toBe(false);
		const missingCrop = joined();
		missingCrop.cropByClip = [null];
		expect(eligible(missingCrop, takes)).toBe(false);
		const reordered = joined();
		reordered.clips.reverse();
		expect(eligible(reordered, takes)).toBe(false);
	});
	it("renders cropping, zoom, padding, blur, and per-clip placement", () => {
		const changes: Array<(value: SceneDescription) => void> = [
			(value) => {
				value.cropByClip = [{ x: 0.1, y: 0, width: 0.9, height: 1 }];
			},
			(value) => {
				value.layout.screenZoom = 2;
			},
			(value) => {
				value.layout.screenFocalPoint.cx = 0.4;
			},
			(value) => {
				value.layout.screenRect!.width = 0.9;
			},
			(value) => {
				value.layout.screenRadiusFrac = 0.1;
			},
			(value) => {
				value.effects.blur = true;
			},
			(value) => {
				value.layout.layoutByClip = [
					{
						screenRect: { x: 0, y: 0, width: 0.9, height: 1 },
						webcamRect: null,
						screenRadiusFrac: null,
						webcamRadiusFrac: null,
						webcamShape: "rectangle",
						screenCover: false,
					},
				];
			},
		];
		for (const change of changes) {
			const value = scene();
			change(value);
			expect(eligible(value)).toBe(false);
		}
	});
	it("renders editable cursor telemetry and mismatching scene/output dimensions", () => {
		expect(eligible(scene(), { hasCursorTrack: true })).toBe(false);
		const hiddenCursor = scene();
		hiddenCursor.cursor.show = false;
		expect(eligible(hiddenCursor, { hasCursorTrack: true })).toBe(true);
		const value = scene();
		value.output.width = 1280;
		expect(eligible(value)).toBe(false);
		value.output.width = 1920;
		value.clips[0]!.screenPath = "/other.mp4";
		expect(eligible(value)).toBe(false);
	});
	it("declines unknown scene features and malformed payloads", () => {
		expect(eligible({ ...scene(), futureEffect: true } as SceneDescription)).toBe(false);
		const value = scene();
		Object.assign(value.layout, { futureEffect: true });
		expect(eligible(value)).toBe(false);
		expect(eligible(scene(), { sceneJson: "{" })).toBe(false);
		expect(eligible(scene(), { sceneJson: undefined })).toBe(false);
	});
});

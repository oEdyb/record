// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";

type ElectronAPI = Window["electronAPI"];

const nativeMocks = vi.hoisted(() => ({
	loadProjectFileFromPath: vi.fn(),
	getRecordingData: vi.fn(async () => ({ samples: [] })),
	exportMultiNative: vi.fn(
		async (_clips: unknown[], _outputPath: string, _sceneJson: string, _settings: unknown) =>
			undefined,
	),
	exportGifNative: vi.fn(async () => undefined),
}));

vi.mock("@/native", () => ({
	nativeBridgeClient: {
		project: { loadProjectFileFromPath: nativeMocks.loadProjectFileFromPath },
		cursor: { getRecordingData: nativeMocks.getRecordingData },
	},
	exportMultiNative: nativeMocks.exportMultiNative,
	exportGifNative: nativeMocks.exportGifNative,
}));

import { runExport } from "./CliExportRunner";

function currentMultiAssetProject() {
	const document = createEmptyDocument({
		title: "CLI integration",
		projectId: "project-cli",
	});
	return {
		...document,
		project: { ...document.project, primaryAssetId: "asset-one" },
		assets: [
			{
				id: "asset-one",
				kind: "video" as const,
				label: "one",
				originalPath: "/media/one.mp4",
				durationSec: 8,
				cameraTrack: {
					sourcePath: "/media/camera-one.mp4",
					startMs: 0,
					offsetMs: 0,
					visible: true,
				},
			},
			{
				id: "asset-two",
				kind: "video" as const,
				label: "two",
				originalPath: "/media/two.mp4",
				durationSec: 8,
				cameraTrack: {
					sourcePath: "/media/camera-two.mp4",
					startMs: 0,
					offsetMs: 120,
					visible: true,
				},
			},
		],
		timeline: {
			...document.timeline,
			// Asset two is deliberately first. This catches asset-array order being
			// used instead of the editor's timeline order.
			clips: [
				{
					id: "clip-two",
					assetId: "asset-two",
					sourceStartSec: 1,
					sourceEndSec: 5,
					timelineStartSec: 0,
					timelineEndSec: 4,
					wordRefs: [],
					origin: "user" as const,
					reason: "reordered first",
					cropRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
				},
				{
					id: "clip-one",
					assetId: "asset-one",
					sourceStartSec: 2,
					sourceEndSec: 6,
					timelineStartSec: 4,
					timelineEndSec: 8,
					wordRefs: [],
					origin: "user" as const,
					reason: "reordered second",
				},
			],
			trimRanges: [
				{
					id: "trim-two",
					assetId: "asset-two",
					clipId: "clip-two",
					startSec: 2,
					endSec: 2.5,
					reason: "remove mistake",
					origin: "user" as const,
				},
			],
		},
		zoomRanges: [
			{
				id: "zoom-one",
				startMs: 4_250,
				endMs: 6_500,
				clipId: "clip-one",
				sourceStartSec: 2.25,
				sourceEndSec: 4.5,
				depth: 3 as const,
				focus: { cx: 0.75, cy: 0.35 },
				source: "manual" as const,
			},
		],
		legacyEditor: {
			aspectRatio: "16:9",
			exportFormat: "mp4",
			exportQuality: "source",
			gifFrameRate: 25,
			gifSizePreset: "large",
			gifLoop: false,
			evenVolume: false,
			normalizeVolume: false,
			audioDeliveryPreset: "custom",
			audioTargetLufs: -18,
			audioPeakCeilingDbtp: -3,
			webcamLayoutPreset: "picture-in-picture",
			cameraFullscreenRegions: [
				{ id: "camera-emphasis", startMs: 500, endMs: 1_500, mode: "emphasis" },
			],
			speedRegions: [{ id: "speed-one", startMs: 5_000, endMs: 6_000, speed: 1.5 }],
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	const createElement = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
		if (tagName.toLowerCase() !== "video") return createElement(tagName);
		const video = {
			preload: "",
			muted: false,
			videoWidth: 1920,
			videoHeight: 1080,
			duration: 8,
			onloadedmetadata: null as null | (() => void),
			onerror: null as null | (() => void),
			removeAttribute: vi.fn(),
			load: vi.fn(),
			set src(_value: string) {
				queueMicrotask(() => this.onloadedmetadata?.());
			},
		};
		return video as unknown as HTMLVideoElement;
	}) as typeof document.createElement);

	window.electronAPI = {
		cliLog: vi.fn(),
		cliProgress: vi.fn(),
		onNativeExportProgress: vi.fn(() => vi.fn()),
	} as unknown as ElectronAPI;
});

describe("runExport", () => {
	it("exports a current two-asset edit with reorder, trim, crop, speed, zoom, and camera data", async () => {
		nativeMocks.loadProjectFileFromPath.mockResolvedValue({
			success: true,
			project: currentMultiAssetProject(),
		});

		const result = await runExport({
			kind: "export",
			projectPath: "/projects/demo.klippt",
			outPath: "/exports/demo.mp4",
			format: null,
			quality: null,
			gifFrameRate: null,
			gifSizePreset: null,
			autoZoom: false,
			audioPath: null,
			audioMode: "mix",
			audioOffsetSec: 0,
		});

		expect(result).toMatchObject({
			success: true,
			format: "mp4",
			outputPath: "/exports/demo.mp4",
		});
		expect(nativeMocks.exportMultiNative).toHaveBeenCalledOnce();
		const [clips, outputPath, sceneJson, settings] = nativeMocks.exportMultiNative.mock.calls[0];
		const nativeClips = clips as Array<{
			screenPath: string;
			webcamPath?: string;
			webcamOffsetSec?: number;
		}>;
		expect(outputPath).toBe("/exports/demo.mp4");
		expect(nativeClips.map((clip) => clip.screenPath)).toEqual([
			"/media/two.mp4",
			"/media/two.mp4",
			"/media/one.mp4",
		]);
		expect(nativeClips[0]).toMatchObject({
			webcamPath: "/media/camera-two.mp4",
			webcamOffsetSec: 0.12,
		});
		// Source quality still respects the smallest effective crop on the timeline.
		expect(settings).toMatchObject({
			width: 1536,
			height: 864,
			evenVolume: false,
			normalizeAudio: false,
			targetLufs: -18,
			peakCeilingDbtp: -3,
		});

		const scene = JSON.parse(sceneJson);
		expect(scene.cropByClip[0]).toEqual({
			x: 0.1,
			y: 0.1,
			width: 0.8,
			height: 0.8,
		});
		expect(scene.zoomRegions).toHaveLength(1);
		expect(scene.speedRegions).toHaveLength(1);
		expect(scene.cameraFullscreenRegions).toHaveLength(1);
	});
});

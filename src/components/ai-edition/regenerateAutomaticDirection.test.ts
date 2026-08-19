// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";

const mocks = vi.hoisted(() => ({
	document: null as AxcutDocument | null,
	getRecordingData: vi.fn(),
	applyDocumentPatch: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		cursor: { getRecordingData: mocks.getRecordingData },
	},
}));

vi.mock("@/lib/ai-edition/store/projectStore", () => ({
	useProjectStore: {
		getState: () => ({
			document: mocks.document,
			applyDocumentPatch: mocks.applyDocumentPatch,
		}),
	},
}));

import {
	canRegenerateAutomaticDirection,
	regenerateProjectAutomaticDirection,
} from "./regenerateAutomaticDirection";

function project(): AxcutDocument {
	const base = createEmptyDocument({ title: "Recorded", projectId: "project-1" });
	return {
		...base,
		assets: [
			{
				id: "asset-1",
				kind: "video",
				label: "Recording",
				originalPath: "/recordings/clip.mp4",
				recordingImportId: "recording-1",
				durationSec: 60,
				cameraTrack: {
					sourcePath: "/recordings/camera.webm",
					startMs: 0,
					offsetMs: 0,
					visible: true,
				},
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "system",
					reason: "Recorded clip",
				},
			],
		},
		zoomRanges: [
			{ id: "old-auto", startMs: 4_000, endMs: 7_000, depth: 3, source: "auto" },
			{ id: "manual", startMs: 7_000, endMs: 9_000, depth: 2, source: "manual" },
		],
		legacyEditor: {
			cameraFullscreenRegions: [
				{ id: "old-auto-camera", startMs: 0, endMs: 4_000, source: "auto" },
			],
		},
	} as AxcutDocument;
}

function microphonePeaks() {
	const peaks = new Float32Array(24_000);
	for (let block = 0; block < 1_200; block++) {
		const amplitude = block % 20 < 10 ? 0.025 : 0.1;
		peaks[block * 2] = -amplitude;
		peaks[block * 2 + 1] = amplitude;
	}
	return peaks;
}

describe("regenerate automatic direction", () => {
	beforeEach(() => {
		mocks.document = project();
		mocks.getRecordingData.mockReset();
		mocks.applyDocumentPatch.mockReset();
		mocks.getRecordingData.mockResolvedValue({
			samples: [
				{ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" },
				{ timeMs: 60_000, cx: 0.5, cy: 0.5, interactionType: "move" },
			],
			keyboardActivity: [],
		});
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: {
				getAudioPeaks: vi.fn(async () => ({ success: true, peaks: microphonePeaks() })),
			},
		});
		mocks.applyDocumentPatch.mockImplementation(async (_projectId, patch, options) => {
			mocks.document = patch(mocks.document!);
			expect(options.createHistorySnapshot(mocks.document)).not.toBe(mocks.document);
			return "applied";
		});
	});

	it("is available only for recorded assets used by the timeline", () => {
		expect(canRegenerateAutomaticDirection(mocks.document)).toBe(true);
		expect(
			canRegenerateAutomaticDirection(
				createEmptyDocument({ title: "Empty", projectId: "empty-project" }),
			),
		).toBe(false);
	});

	it("replaces automatic edits in one undoable patch and preserves manual edits", async () => {
		const result = await regenerateProjectAutomaticDirection("project-1");

		expect(mocks.applyDocumentPatch).toHaveBeenCalledOnce();
		expect(window.electronAPI?.getAudioPeaks).toHaveBeenCalledWith(
			"/recordings/clip.mp4",
			60,
			"microphone",
		);
		expect(mocks.document?.zoomRanges.some((region) => region.id === "old-auto")).toBe(false);
		expect(mocks.document?.zoomRanges.some((region) => region.id === "manual")).toBe(true);
		const camera = (
			mocks.document?.legacyEditor as { cameraFullscreenRegions: Array<{ id: string }> }
		).cameraFullscreenRegions;
		expect(camera.some((region) => region.id === "old-auto-camera")).toBe(false);
		expect(camera.some((region) => region.id.startsWith("auto-direction:regenerated-"))).toBe(true);
		expect(result.cameraEmphasis).toBe(1);
	});

	it("keeps new recording edits when the source set changes during analysis", async () => {
		let finishAnalysis!: (value: { success: true; peaks: Float32Array }) => void;
		const analysis = new Promise<{ success: true; peaks: Float32Array }>((resolve) => {
			finishAnalysis = resolve;
		});
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { getAudioPeaks: vi.fn(() => analysis) },
		});

		const regeneration = regenerateProjectAutomaticDirection("project-1");
		await vi.waitFor(() => expect(window.electronAPI?.getAudioPeaks).toHaveBeenCalledOnce());
		mocks.document = {
			...mocks.document!,
			assets: [
				...mocks.document!.assets,
				{
					id: "asset-2",
					kind: "video",
					label: "New recording",
					originalPath: "/recordings/new-clip.mp4",
					recordingImportId: "recording-2",
					durationSec: 10,
				},
			],
			timeline: {
				...mocks.document!.timeline,
				clips: [
					...mocks.document!.timeline.clips,
					{
						id: "clip-2",
						assetId: "asset-2",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 60,
						timelineEndSec: 70,
						wordRefs: [],
						origin: "system",
						reason: "New recorded clip",
					},
				],
			},
			zoomRanges: [
				...mocks.document!.zoomRanges,
				{ id: "new-auto", startMs: 61_000, endMs: 64_000, depth: 1.5, source: "auto" },
			],
		} as AxcutDocument;
		finishAnalysis({ success: true, peaks: microphonePeaks() });

		await expect(regeneration).rejects.toThrow(
			"The project recordings changed during analysis. Regenerate again",
		);
		expect(mocks.document.zoomRanges.some((region) => region.id === "new-auto")).toBe(true);
		expect(mocks.document.assets.some((asset) => asset.id === "asset-2")).toBe(true);
	});
});

// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { seedProjectState } from "@/lib/ai-edition/store/projectStore.testUtils";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { useProjectStore } from "./projectStore";
import { useAssetDimensionBackfill } from "./useAssetDimensionBackfill";

// Ported from the retired editor timeline hook tests ("backfills missing source dimensions on load").

const probeVideoDimensionsMock = vi.hoisted(() => vi.fn());
vi.mock("../timeline/duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../timeline/duration")>();
	return { ...actual, probeVideoDimensions: probeVideoDimensionsMock };
});

const save = vi.hoisted(() => vi.fn());
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: { save } } }));

function documentWithAsset(video: AxcutDocument["assets"][number]["video"]): AxcutDocument {
	const document = createEmptyDocument({ title: "Test", projectId: "proj_test" });
	document.assets = [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 30,
			video,
			cameraTrack: null,
		},
	];
	document.timeline.clips = [
		{
			id: "clip_a",
			assetId: "asset_1",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "",
		},
	];
	return document;
}

function load(document: AxcutDocument) {
	seedProjectState({
		projectId: "proj_test",
		document,
		revision: 1,
		status: "ready",
		error: null,
	});
}

describe("useAssetDimensionBackfill", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		save.mockReset();
		save.mockImplementation(async (doc: AxcutDocument) => ({
			success: true,
			document: doc,
		}));
		probeVideoDimensionsMock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// A project saved with a duration but no probed `video` dims drops that clip from
	// everything reading asset.video: the ratio list, output resolution, export badges.
	it("probes a used asset that has a duration but no video dims, and persists them", async () => {
		load(documentWithAsset(undefined));
		renderHook(() => useAssetDimensionBackfill());
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		const saved = useProjectStore.getState().document?.assets.find((a) => a.id === "asset_1");
		expect(saved?.video).toMatchObject({ width: 1920, height: 1080 });
	});

	it("leaves an asset that already has video dims untouched", async () => {
		load(documentWithAsset({ codec: "unknown", width: 1920, height: 1080, fps: 0 }));
		renderHook(() => useAssetDimensionBackfill());
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("probes the camera file once and stores its real size on the camera track", async () => {
		const document = documentWithAsset({ codec: "unknown", width: 1920, height: 1080, fps: 0 });
		document.assets[0].cameraTrack = {
			sourcePath: "/tmp/camera.mp4",
			startMs: 0,
			offsetMs: 0,
			visible: true,
		};
		probeVideoDimensionsMock.mockResolvedValue({ width: 1552, height: 1552 });
		load(document);
		renderHook(() => useAssetDimensionBackfill());
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(probeVideoDimensionsMock).toHaveBeenCalledWith(toFileUrl("/tmp/camera.mp4"));
		const saved = useProjectStore.getState().document?.assets[0];
		expect(saved?.cameraTrack).toMatchObject({
			sourcePath: "/tmp/camera.mp4",
			width: 1552,
			height: 1552,
		});
		expect(saved?.video).toMatchObject({ width: 1920, height: 1080 });
	});

	it("does not re-probe a used asset with no reachable file more than once", async () => {
		probeVideoDimensionsMock.mockResolvedValue(null);
		load(documentWithAsset(undefined));
		const { rerender } = renderHook(() => useAssetDimensionBackfill());
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		rerender();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(save).not.toHaveBeenCalled();
	});
});

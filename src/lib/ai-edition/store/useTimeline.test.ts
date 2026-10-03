// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";
import { useTimeline } from "./useTimeline";

/**
 * `useTimeline` reads the locale — `addAnnotation` seeds a new region with the
 * translated default text — so it needs the provider. One helper rather than a
 * wrapper argument on every call site.
 */
const renderTimeline = () => renderHook(() => useTimeline(), { wrapper: I18nProvider });

const probeVideoDurationMock = vi.hoisted(() => vi.fn());
const probeVideoDimensionsMock = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
);

vi.mock("../timeline/duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../timeline/duration")>();
	return {
		...actual,
		probeVideoDuration: probeVideoDurationMock,
		probeVideoDimensions: probeVideoDimensionsMock,
	};
});

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

const sampleDoc: AxcutDocument = {
	// ponytail: the bridge contract after the migration hoist is the CURRENT version —
	// every load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a pure current-version
	// validator. Test fixtures model the post-hoist contract, so they read the version
	// off `axcutSchemaVersion` instead of restating it.
	// Annotated `AxcutDocument` rather than left to inference: the document type
	// pins `schemaVersion` to the LITERAL 7 and `kind` to `"video"`, both of which
	// an unannotated object literal widens — and the annotation makes every
	// required field (`cameraTrack`) a compile error when it is missing instead of
	// a fixture that silently drifts from the schema.
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 30,
			video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
			// No webcam was recorded alongside this screen capture.
			cameraTrack: null,
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
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
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
};

describe("useTimeline.insertClipAt background duration probe", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [
					...sampleDoc.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "long.webm",
						originalPath: "/tmp/long.webm",
						durationSec: undefined,
						video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
						cameraTrack: null,
					},
				],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("only resizes the probed clip and leaves earlier clips' positions untouched", async () => {
		// clip_a already sits at 0..10 (a "short clip"). Insert a second clip
		// for asset_2 after it — insertClipAt has no cached duration for
		// asset_2, so it lands at the 60s placeholder, then the background
		// probe (mocked here to resolve to a much shorter real duration)
		// corrects it. Regression test for the bug where the probe used to
		// shift EVERY sibling clip (including ones before it) by the delta
		// between the real and placeholder duration, corrupting their
		// positions and producing visual overlap.
		probeVideoDurationMock.mockResolvedValue(5);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.insertClipAt("asset_2", 1);
		});

		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(2);
		const clipA = clips?.find((c) => c.id === "clip_a");
		const inserted = clips?.find((c) => c.assetId === "asset_2");
		expect(clipA).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(inserted).toMatchObject({
			sourceEndSec: 5,
			timelineStartSec: 10,
			timelineEndSec: 15,
		});
	});
});

describe("useTimeline.addZoomsBulk", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("keeps edits added while cursor telemetry was loading", async () => {
		const { result } = renderTimeline();
		const addZoomsBulk = result.current.addZoomsBulk;
		useProjectStore.setState({
			document: {
				...sampleDoc,
				zoomRanges: [
					{
						id: "manual_zoom",
						startMs: 1_000,
						endMs: 3_000,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
						focusMode: "manual",
					},
				],
			},
		});

		let added = 0;
		await act(async () => {
			added = await addZoomsBulk([
				{
					span: { start: 2_000, end: 4_000 },
					focus: { cx: 0.2, cy: 0.4 },
					focusMode: "manual",
					customScale: 1.65,
					source: "auto",
				},
				{
					span: { start: 5_000, end: 7_000 },
					focus: { cx: 0.8, cy: 0.4 },
					focusMode: "manual",
					customScale: 1.5,
					source: "auto",
				},
			]);
		});

		expect(added).toBe(1);
		expect(useProjectStore.getState().document?.zoomRanges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "manual_zoom" }),
				expect.objectContaining({ startMs: 5_000, endMs: 7_000, source: "auto" }),
			]),
		);
	});
});

describe("useTimeline.moveClip / duplicateClip (delegates to document/timeline.ts)", () => {
	const twoClipDoc: AxcutDocument = {
		...sampleDoc,
		timeline: {
			...sampleDoc.timeline,
			clips: [
				sampleDoc.timeline.clips[0],
				{
					id: "clip_b",
					assetId: "asset_1",
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 10,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: twoClipDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("moveClip reorders clips and persists the resequenced timeline", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips?.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(clips?.[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(clips?.[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 20 });
	});

	it("restores a clip reorder with Undo and Redo", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_b",
			"clip_a",
		]);

		act(() => expect(undo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_a",
			"clip_b",
		]);
		act(() => expect(redo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_b",
			"clip_a",
		]);
	});

	it("moveClip no-ops for an unknown clip id", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_missing", 0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("splits at the playhead as one undoable edit and keeps the new insertion boundary", async () => {
		const { result } = renderTimeline();
		act(() => useProjectStore.getState().setCurrentTime(4));

		await act(async () => {
			expect(await result.current.splitClipAtPlayhead()).toBe(true);
		});

		const split = useProjectStore.getState().document?.timeline.clips ?? [];
		expect(
			split.map(({ sourceStartSec, sourceEndSec, timelineStartSec, timelineEndSec }) => ({
				sourceStartSec,
				sourceEndSec,
				timelineStartSec,
				timelineEndSec,
			})),
		).toEqual([
			{ sourceStartSec: 0, sourceEndSec: 4, timelineStartSec: 0, timelineEndSec: 4 },
			{ sourceStartSec: 4, sourceEndSec: 10, timelineStartSec: 4, timelineEndSec: 10 },
			{ sourceStartSec: 10, sourceEndSec: 20, timelineStartSec: 10, timelineEndSec: 20 },
		]);
		expect(useProjectStore.getState().currentTimeSec).toBe(4);
		expect(result.current.clipSelection).toBe(split[1].id);

		act(() => expect(undo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_a",
			"clip_b",
		]);
		act(() => expect(redo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(3);
	});

	it("does not split when the playhead is already on a clip boundary", async () => {
		const { result } = renderTimeline();
		act(() => useProjectStore.getState().setCurrentTime(10));

		await act(async () => {
			expect(await result.current.splitClipAtPlayhead()).toBe(false);
		});

		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("makes clip in/out changes undoable", async () => {
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 1, 8);
		});
		expect(useProjectStore.getState().document?.timeline.clips[0]).toMatchObject({
			sourceStartSec: 1,
			sourceEndSec: 8,
			timelineStartSec: 0,
			timelineEndSec: 7,
		});

		act(() => expect(undo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 10,
		});
		act(() => expect(redo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips[0]).toMatchObject({
			sourceStartSec: 1,
			sourceEndSec: 8,
		});
	});

	it("duplicateClip inserts a copy right after the original and selects it", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.duplicateClip("clip_a");
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(3);
		expect(clips?.[0].id).toBe("clip_a");
		expect(clips?.[2].id).toBe("clip_b");
		const copyId = clips?.[1].id;
		expect(copyId).toBeTruthy();
		expect(copyId).not.toBe("clip_a");
		expect(result.current.clipSelection).toBe(copyId);
	});

	it("duplicateClip no-ops for an unknown clip id", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.duplicateClip("clip_missing");
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("deletes a clip at its start boundary and restores it with undo and redo", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(17);
			result.current.selectClip("clip_b");
		});

		await act(async () => {
			await result.current.removeClip("clip_b");
		});

		expect(useProjectStore.getState().currentTimeSec).toBe(10);
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_a",
		]);

		act(() => expect(undo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_a",
			"clip_b",
		]);

		act(() => expect(redo()).toBe(true));
		expect(useProjectStore.getState().document?.timeline.clips.map((clip) => clip.id)).toEqual([
			"clip_a",
		]);
	});
});

describe("useTimeline backfills missing source dimensions on load", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDimensionsMock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// The reported bug: a project saved with a duration but no probed `video` dims (nothing
	// re-probes it on open) drops that clip from everything reading asset.video — the ratio
	// picker's ORIGINAL list, the output resolution, the export badges.
	it("probes a used asset that has a duration but no video dims, and persists them", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [{ ...sampleDoc.assets[0], video: undefined }],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		const saved = useProjectStore.getState().document?.assets.find((a) => a.id === "asset_1");
		expect(saved?.video).toMatchObject({ width: 1920, height: 1080 });
	});

	it("leaves an asset that already has video dims untouched", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc, // asset_1 already carries 1920x1080
			revision: 1,
			status: "ready",
			error: null,
		});
		renderTimeline();
		// Give any stray effect a chance to fire before asserting it didn't.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("does not re-probe a used asset with no reachable file more than once", async () => {
		probeVideoDimensionsMock.mockResolvedValue(null); // probe fails (unreadable file)
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [{ ...sampleDoc.assets[0], video: undefined }],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
		const { rerender } = renderTimeline();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		rerender();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		// Attempted once; the failure is remembered so a document change doesn't spin it again.
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline.updateClipSourceRange (Edit-clip modal)", () => {
	const anchoredZoom = (id: string, s: number, e: number) => ({
		id,
		startMs: s * 1000,
		endMs: e * 1000,
		clipId: "clip_a",
		sourceStartSec: s,
		sourceEndSec: e,
		depth: 3 as const,
		focus: { cx: 0.5, cy: 0.5 },
	});

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_keep", 2, 3), anchoredZoom("z_drop", 6, 8)],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("shrinks the clip's timeline width to match the narrowed source window", async () => {
		const { result } = renderTimeline();
		// Trim the 10s clip down to its first 4s of source.
		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 0, 4);
		});
		const clip = useProjectStore.getState().document?.timeline.clips[0];
		expect(clip).toMatchObject({ sourceStartSec: 0, sourceEndSec: 4 });
		// The width followed the edit instead of keeping its stale 10s extent.
		expect(clip?.timelineStartSec).toBe(0);
		expect(clip?.timelineEndSec).toBe(4);
	});

	it("drops a pill sitting over the truncated tail and keeps the one that survives", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 0, 4);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		// z_keep (source 2-3) stays; z_drop (source 6-8) is entirely past the new 4s end.
		expect(zooms.map((z) => z.id)).toEqual(["z_keep"]);
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 2,
			sourceEndSec: 3,
			startMs: 2000,
			endMs: 3000,
		});
	});

	it("shortens a pill that straddles the new clip end to the surviving overlap", async () => {
		useProjectStore.setState({
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_edge", 3, 7)],
			},
		});
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateClipSourceRange("clip_a", 0, 5);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		expect(zooms).toHaveLength(1);
		// 3-7 clamped to the [0,5] window → 3-5.
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 3,
			sourceEndSec: 5,
			startMs: 3000,
			endMs: 5000,
		});
	});
});

describe("useTimeline.addAnnotation", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("creates a text annotation carrying the localised default text", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addAnnotation();
		});
		const annotations = useProjectStore.getState().document?.annotations ?? [];
		expect(annotations).toHaveLength(1);
		// Real text, not an empty field. An empty annotation renders nothing at
		// all, so adding one used to change nothing on the canvas; the
		// inspector's placeholder is CSS ghost text that never reaches `content`
		// and therefore never reached the compositor. DEFAULT_LOCALE is `en`.
		expect(annotations[0]).toMatchObject({ type: "text", content: "Hello" });
		// Still auto-selected, so its inspector opens ready to be typed over.
		expect(result.current.selection).toEqual({
			kind: "annotation",
			id: (annotations[0] as { id: string }).id,
		});
	});
});

describe("useTimeline zoom modifiers (rotation + focus mode)", () => {
	const docWithZoom: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				// v5 clip anchor: clip_a draws source 0..10 at timeline 0..10, so the
				// 1000..3000ms ruler span is source 1..3 of that clip. `startMs`/`endMs`
				// stay as the derived cache. (The fixture used to carry a
				// `clipStartOffsetMs` that exists in no schema and no reader.)
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: docWithZoom,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("sets a 3D rotation preset on the region", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "iso");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			id: "zoom_a",
			rotationPreset: "iso",
		});
	});

	it("clears the preset back to a flat frame", async () => {
		// "None" in the UI is the ABSENCE of a preset, not a fourth one: the schema field is
		// optional and the native side treats anything unrecognised as zero rotation.
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "iso");
		});
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", undefined);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].rotationPreset).toBeUndefined();
	});

	it("switches focus mode without disturbing the rotation preset", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "left");
		});
		await act(async () => {
			await result.current.updateZoomFocusMode("zoom_a", "auto");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			rotationPreset: "left",
			focusMode: "auto",
		});
	});
});

// Regression guard for the playhead-stutter fix. `currentTimeSec` is rewritten on
// every animation frame during playback, and `useTimeline()` is called by the editor
// shell — so subscribing to the playhead here re-rendered the entire editor (timeline,
// clips, waveforms, inspector) 60×/s, which is exactly what made the playhead itself
// stutter. The hook must read the playhead imperatively: zero re-renders per tick, but
// still the LIVE value at the moment an action fires.
describe("useTimeline is not re-rendered by playhead ticks", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
			currentTimeSec: 0,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not re-render across a second of 60 Hz playhead writes", () => {
		let renders = 0;
		renderHook(
			() => {
				renders++;
				return useTimeline();
			},
			{ wrapper: I18nProvider },
		);
		const baseline = renders;

		// One act() per write: a single batched act() would collapse all 60 into one
		// React pass and hide the very thing this asserts.
		for (let i = 1; i <= 60; i++) {
			act(() => {
				useProjectStore.getState().setCurrentTime(i / 60);
			});
		}

		expect(renders - baseline).toBe(0);
		expect(useProjectStore.getState().currentTimeSec).toBeCloseTo(1);
	});

	it("still anchors a new region at the live playhead", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom();
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 6200,
			motionStyle: "smooth",
			motionSpeed: 1,
		});
	});

	it("stores Smooth explicitly on a new camera region", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraFullscreen();
		});
		const legacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions?: Array<{ motionStyle?: string }>;
		};
		expect(legacy.cameraFullscreenRegions?.at(-1)).toMatchObject({
			motionStyle: "smooth",
			motionSpeed: 1,
		});
	});

	// Pasting a copied trim is exactly this call: a trim carries no properties, so
	// all a copy holds is its length, and paste recreates one that long at the
	// playhead. Same primitive the toolbar's cut button uses.
	it("creates a trim of the requested length", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(3);
		});
		await act(async () => {
			await result.current.addTrim(1.25);
		});
		const trim = useProjectStore.getState().document?.timeline.trimRanges.at(-1);
		expect((trim?.endSec ?? 0) - (trim?.startSec ?? 0)).toBeCloseTo(1.25, 6);
	});

	// The timeline's toolbar passes a duration worth a fixed number of pixels at
	// the current zoom; every other entry point keeps the 2 s above.
	it("honours a caller-supplied duration", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom(0.4);
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 4600,
		});
	});
});

describe("useTimeline motion history", () => {
	beforeEach(() => {
		clearHistory();
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				zoomRanges: [
					{
						id: "zoom-motion",
						startMs: 1_000,
						endMs: 4_000,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
						motionStyle: "smooth",
					},
				],
				legacyEditor: {
					cameraFullscreenRegions: [
						{ id: "camera-motion", startMs: 4_000, endMs: 8_000, motionStyle: "smooth" },
					],
				},
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("undoes a screen Zoom motion change", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomMotionStyle("zoom-motion", "instant");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].motionStyle).toBe("instant");

		act(() => expect(undo()).toBe(true));
		expect(useProjectStore.getState().document?.zoomRanges[0].motionStyle).toBe("smooth");
	});

	it("undoes a Camera Emphasis motion change", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateCameraMotionStyle("camera-motion", "linear");
		});
		const currentLegacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ motionStyle?: string }>;
		};
		expect(currentLegacy.cameraFullscreenRegions[0].motionStyle).toBe("linear");

		act(() => expect(undo()).toBe(true));
		const restoredLegacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ motionStyle?: string }>;
		};
		expect(restoredLegacy.cameraFullscreenRegions[0].motionStyle).toBe("smooth");
	});

	it("sets how much an emphasis region grows the camera, within the shared bound", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateCameraScale("camera-motion", 1.75);
		});
		const legacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ cameraScale?: number }>;
		};
		expect(legacy.cameraFullscreenRegions[0].cameraScale).toBe(1.75);
		await act(async () => {
			await result.current.updateCameraScale("camera-motion", 9);
		});
		const clamped = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ cameraScale?: number }>;
		};
		expect(clamped.cameraFullscreenRegions[0].cameraScale).toBe(2);
		act(() => expect(undo()).toBe(true));
		act(() => expect(undo()).toBe(true));
		const restored = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ cameraScale?: number }>;
		};
		expect(restored.cameraFullscreenRegions[0].cameraScale).toBeUndefined();
	});

	it("undoes independent screen and camera motion-speed changes", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomMotionSpeed("zoom-motion", 1.5);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].motionSpeed).toBe(1.5);
		act(() => expect(undo()).toBe(true));
		expect(useProjectStore.getState().document?.zoomRanges[0].motionSpeed).toBeUndefined();

		await act(async () => {
			await result.current.updateCameraMotionSpeed("camera-motion", 0.75);
		});
		const currentLegacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ motionSpeed?: number }>;
		};
		expect(currentLegacy.cameraFullscreenRegions[0].motionSpeed).toBe(0.75);
		act(() => expect(undo()).toBe(true));
		const restoredLegacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ motionSpeed?: number }>;
		};
		expect(restoredLegacy.cameraFullscreenRegions[0].motionSpeed).toBeUndefined();
	});
});

describe("useTimeline automatic direction ownership", () => {
	beforeEach(() => {
		clearHistory();
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				zoomRanges: [
					{
						id: "zoom-a",
						startMs: 1_000,
						endMs: 3_000,
						depth: 3,
						focus: { cx: 0.25, cy: 0.5 },
						customScale: 1.65,
						source: "auto",
						directionGroupId: "screen-passage",
					},
					{
						id: "zoom-b",
						startMs: 3_500,
						endMs: 5_500,
						depth: 3,
						focus: { cx: 0.75, cy: 0.5 },
						customScale: 1.65,
						source: "auto",
						directionGroupId: "screen-passage",
					},
				],
				legacyEditor: {
					cameraFullscreenRegions: [
						{
							id: "camera-a",
							startMs: 6_000,
							endMs: 8_000,
							source: "auto",
							directionGroupId: "camera-passage",
						},
						{
							id: "camera-b",
							startMs: 8_000,
							endMs: 10_000,
							source: "auto",
							directionGroupId: "camera-passage",
						},
					],
				},
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("edits the rendered scale and promotes the full connected passage as one undo step", async () => {
		const { result } = renderTimeline();
		act(() => result.current.updateZoomScaleLive("zoom-a", 1.42));
		await act(async () => result.current.commitZoomScale());

		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		expect(zooms.map((region) => region.source)).toEqual(["manual", "manual"]);
		expect(zooms[0].customScale).toBe(1.42);
		expect(zooms[1].customScale).toBe(1.65);

		act(() => expect(undo()).toBe(true));
		const restored = useProjectStore.getState().document?.zoomRanges ?? [];
		expect(restored.map((region) => region.source)).toEqual(["auto", "auto"]);
		expect(restored[0].customScale).toBe(1.65);
	});

	it("promotes every camera member before changing one member's motion", async () => {
		const { result } = renderTimeline();
		await act(async () => result.current.updateCameraMotionStyle("camera-b", "linear"));

		const legacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ source?: string; motionStyle?: string }>;
		};
		expect(legacy.cameraFullscreenRegions.map((region) => region.source)).toEqual([
			"manual",
			"manual",
		]);
		expect(legacy.cameraFullscreenRegions[1].motionStyle).toBe("linear");
	});

	it.each([
		[
			"resizing",
			async (timeline: ReturnType<typeof useTimeline>) =>
				timeline.updateZoomSpan("zoom-a", 1_100, 3_100),
		],
		[
			"reframing",
			async (timeline: ReturnType<typeof useTimeline>) => {
				timeline.updateZoomFocusLive("zoom-a", { cx: 0.4, cy: 0.6 });
				await timeline.commitZoomFocus();
			},
		],
		[
			"changing tracking",
			async (timeline: ReturnType<typeof useTimeline>) =>
				timeline.updateZoomFocusMode("zoom-a", "auto"),
		],
		[
			"changing 3D tilt",
			async (timeline: ReturnType<typeof useTimeline>) =>
				timeline.updateZoomRotation("zoom-a", "iso"),
		],
		[
			"changing motion style",
			async (timeline: ReturnType<typeof useTimeline>) =>
				timeline.updateZoomMotionStyle("zoom-a", "snappy"),
		],
		[
			"changing motion speed",
			async (timeline: ReturnType<typeof useTimeline>) =>
				timeline.updateZoomMotionSpeed("zoom-a", 1.5),
		],
	] as const)("promotes the full screen passage when %s", async (_label, edit) => {
		const { result } = renderTimeline();
		await act(async () => edit(result.current));

		expect(useProjectStore.getState().document?.zoomRanges.map((region) => region.source)).toEqual([
			"manual",
			"manual",
		]);
	});

	it.each([
		[
			"resizing",
			async (timeline: ReturnType<typeof useTimeline>) =>
				timeline.updateCameraFullscreenSpan("camera-a", 6_100, 7_900),
		],
		[
			"changing motion speed",
			async (timeline: ReturnType<typeof useTimeline>) =>
				timeline.updateCameraMotionSpeed("camera-a", 1.5),
		],
	] as const)("promotes the full camera passage when %s", async (_label, edit) => {
		const { result } = renderTimeline();
		await act(async () => edit(result.current));

		const legacy = useProjectStore.getState().document?.legacyEditor as {
			cameraFullscreenRegions: Array<{ source?: string }>;
		};
		expect(legacy.cameraFullscreenRegions.length).toBeGreaterThan(0);
		expect(legacy.cameraFullscreenRegions.every((region) => region.source === "manual")).toBe(true);
	});

	it("keeps the rest of an automatic screen passage manual after one target is deleted", async () => {
		const { result } = renderTimeline();
		await act(async () => result.current.removeRegion("zoom", "zoom-a"));

		expect(useProjectStore.getState().document?.zoomRanges).toEqual([
			expect.objectContaining({ id: "zoom-b", source: "manual" }),
		]);
	});
});

describe("useTimeline selection", () => {
	// A pill and a clip are one selection, not two. While both could be set at
	// once, copy/paste keyed off "is a clip selected?" and so acted on the clip
	// whatever the user had actually clicked.
	it("lets a clip and a pill cancel each other", () => {
		const { result } = renderTimeline();

		act(() => result.current.selectClip("clip_1"));
		expect(result.current.clipSelection).toBe("clip_1");

		act(() => result.current.selectRegion("zoom", "z1"));
		expect(result.current.selection).toMatchObject({ kind: "zoom", id: "z1" });
		expect(result.current.clipSelection).toBeNull();

		act(() => result.current.selectClip("clip_2"));
		expect(result.current.clipSelection).toBe("clip_2");
		expect(result.current.selection).toBeNull();
		expect(result.current.multiSelection).toEqual([]);

		act(() => result.current.clearSelection());
		expect(result.current.selection).toBeNull();
		expect(result.current.clipSelection).toBeNull();
	});
});

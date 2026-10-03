import { describe, expect, it } from "vitest";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import { prepareAgentEditPlan } from "./agentEditPlan";

function fixture() {
	return documentSchema.parse({
		...createEmptyDocument({
			title: "Proof",
			projectId: "p",
			createdAt: "2026-09-07T00:00:00.000Z",
		}),
		assets: [
			{
				id: "a",
				kind: "video",
				label: "Screen",
				originalPath: "/screen.mp4",
				durationSec: 24,
				cameraTrack: { sourcePath: "/camera.mp4" },
			},
		],
		timeline: {
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 24,
					timelineStartSec: 0,
					timelineEndSec: 24,
					origin: "user",
				},
			],
		},
		legacyEditor: { wallpaper: "#123456", cropRegion: { x: 0, y: 0, width: 1, height: 1 } },
	});
}

describe("prepared agent edits", () => {
	it("prepares portrait output and camera placement through shared settings without changing the base", () => {
		const base = fixture();
		const before = JSON.stringify(base);
		const plan = prepareAgentEditPlan(base, [
			{
				type: "set-layout",
				settings: {
					aspectRatio: "9:16",
					outputResolution: { width: 1080, height: 1920 },
					webcamPosition: { cx: 0.8, cy: 0.2 },
					webcamSizePreset: 65,
					webcamReactiveZoom: false,
					webcamMaskShape: "squircle",
					webcamCornerRadius: 35,
					webcamAspectRatio: "4:3",
					padding: 10,
				},
			},
		]);
		expect(getEditorSettings(plan.candidate)).toMatchObject({
			aspectRatio: "9:16",
			webcamPosition: { cx: 0.8, cy: 0.2 },
			webcamSizePreset: 65,
			webcamReactiveZoom: false,
			webcamMaskShape: "squircle",
			webcamCornerRadius: 35,
			webcamAspectRatio: "4:3",
			wallpaper: "#123456",
		});
		expect(plan.settings_changed).toBe(true);
		expect(JSON.stringify(base)).toBe(before);
		expect(Object.isFrozen(base.legacyEditor?.cropRegion)).toBe(false);
		expect(
			prepareAgentEditPlan(base, [{ type: "set-layout", settings: { aspectRatio: "683:384" } }])
				.candidate.legacyEditor?.aspectRatio,
		).toBe("683:384");
	});
	it("sets screen framing for the resulting output variant and preserves other variants", () => {
		const base = fixture();
		base.legacyEditor = {
			...base.legacyEditor,
			screenFramingByVariant: { "16:9": { scale: 1.2, focalPoint: { cx: 0.4, cy: 0.6 } } },
		};
		const plan = prepareAgentEditPlan(base, [
			{
				type: "set-layout",
				settings: {
					aspectRatio: "9:16",
					outputResolution: { width: 1080, height: 1920 },
					screenFraming: { scale: 2, focalPoint: { cx: 0.2, cy: 0.7 } },
					webcamZoom: 1.5,
					webcamFocalPoint: { cx: 0.3, cy: 0.8 },
				},
			},
		]);
		expect(getEditorSettings(plan.candidate)).toMatchObject({
			webcamZoom: 1.5,
			webcamFocalPoint: { cx: 0.3, cy: 0.8 },
			screenFramingByVariant: {
				"16:9": { scale: 1.2, focalPoint: { cx: 0.4, cy: 0.6 } },
				"9:16": { scale: 2, focalPoint: { cx: 0.2, cy: 0.7 } },
			},
		});
	});
	it("validates all operations strictly including nested properties and cross-field crop bounds", () => {
		for (const operations of [
			[{ type: "set-layout", settings: { arbitraryBlob: {} } }],
			[{ type: "set-layout", settings: { cropRegion: { x: 0.8, y: 0, width: 0.5, height: 1 } } }],
			[{ type: "set-layout", settings: { webcamPosition: { cx: 0.5, cy: 0.5, hidden: true } } }],
			[{ type: "addZoom", args: { startSec: 1, endSec: 3, focus: { cx: 0.5, cy: 0.5, z: 2 } } }],
			[{ type: "addZooms", args: { regions: [] } }],
		])
			expect(() => prepareAgentEditPlan(fixture(), operations)).toThrow();
	});
	it("rejects invalid or clamped ranges and rolls back the entire private batch", () => {
		const base = fixture();
		const before = JSON.stringify(base);
		for (const args of [
			{ startSec: 4, endSec: 2 },
			{ startSec: 20, endSec: 30 },
		]) {
			expect(() =>
				prepareAgentEditPlan(base, [
					{ type: "set-layout", settings: { padding: 25 } },
					{ type: "addZoom", args },
				]),
			).toThrow("OPERATION_FAILED at index 1");
		}
		expect(() =>
			prepareAgentEditPlan(base, [
				{ type: "addZoom", args: { startSec: 1, endSec: 3 } },
				{ type: "removeClip", args: { clipId: "missing" } },
			]),
		).toThrow();
		expect(JSON.stringify(base)).toBe(before);
	});
	it("retains generated IDs in a frozen prepared candidate for apply without rerunning tools", () => {
		const plan = prepareAgentEditPlan(fixture(), [
			{ type: "addZoom", args: { startSec: 1, endSec: 3 } },
			{ type: "addCameraFullscreen", args: { startSec: 5, endSec: 8 } },
		]);
		const id = plan.candidate.zoomRanges[0].id;
		expect(id).toMatch(/^zoom_/);
		expect(plan.changed_ids).toContain(id);
		expect(plan.candidate.zoomRanges[0]).toMatchObject({
			clipId: "c",
			sourceStartSec: 1,
			sourceEndSec: 3,
		});
		expect(JSON.parse(JSON.stringify(plan.candidate)).zoomRanges[0].id).toBe(id);
		expect(Object.isFrozen(plan.candidate.zoomRanges[0])).toBe(true);
	});
	it("adds an image annotation with ordinary anchored placement and rejects network image input", () => {
		const image = "data:image/png;base64,iVBORw0KGgo=";
		const plan = prepareAgentEditPlan(fixture(), [
			{
				type: "addAnnotation",
				args: {
					startSec: 2,
					endSec: 4,
					imageDataUrl: image,
					position: { x: 20, y: 30 },
					size: { width: 50, height: 10 },
				},
			},
		]);
		expect(plan.candidate.annotations[0]).toMatchObject({
			type: "image",
			imageContent: image,
			clipId: "c",
			position: { x: 20, y: 30 },
			size: { width: 50, height: 10 },
		});
		expect(() =>
			prepareAgentEditPlan(fixture(), [
				{
					type: "addAnnotation",
					args: { startSec: 2, endSec: 4, imageDataUrl: "https://example.com/img.png" },
				},
			]),
		).toThrow();
	});
	it("requires trim bounds to belong to a known explicit clip", () => {
		expect(() =>
			prepareAgentEditPlan(fixture(), [{ type: "addTrim", args: { startSec: 1, endSec: 3 } }]),
		).toThrow();
		expect(() =>
			prepareAgentEditPlan(fixture(), [
				{ type: "addTrim", args: { clipId: "c", startSec: 23, endSec: 26 } },
			]),
		).toThrow();
		expect(
			prepareAgentEditPlan(fixture(), [
				{ type: "addTrim", args: { clipId: "c", startSec: 1, endSec: 3 } },
			]).candidate.timeline.trimRanges[0],
		).toMatchObject({ clipId: "c", startSec: 1, endSec: 3 });
	});
	it("stores supported zoom presentation and reports the actual custom scale", () => {
		const first = prepareAgentEditPlan(fixture(), [
			{
				type: "addZoom",
				args: { startSec: 2, endSec: 4, motionStyle: "snappy", customScale: 1.5 },
			},
		]);
		expect(first.candidate.zoomRanges[0]).toMatchObject({
			motionStyle: "snappy",
			customScale: 1.5,
		});
		expect(first.results[0].result).toMatchObject({ renderedScale: 1.5 });
		const updated = prepareAgentEditPlan(first.candidate, [
			{
				type: "setZoom",
				args: {
					zoomId: first.candidate.zoomRanges[0].id,
					motionStyle: "linear",
					customScale: 2,
				},
			},
		]);
		expect(updated.candidate.zoomRanges[0]).toMatchObject({
			motionStyle: "linear",
			customScale: 2,
		});
		expect(updated.results[0].result).toMatchObject({ renderedScale: 2 });
	});
	it("preserves image animation through the ordinary annotation style schema", () => {
		const plan = prepareAgentEditPlan(fixture(), [
			{
				type: "addAnnotation",
				args: {
					startSec: 2,
					endSec: 4,
					imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
					style: { textAnimation: "fade" },
				},
			},
		]);
		expect(plan.candidate.annotations[0]).toMatchObject({
			type: "image",
			style: { textAnimation: "fade" },
		});
		for (const args of [
			{ startSec: 2, endSec: 4, style: { textAnimation: "invented" } },
			{ startSec: 2, endSec: 4, style: { arbitrary: true } },
		])
			expect(() => prepareAgentEditPlan(fixture(), [{ type: "addAnnotation", args }])).toThrow();
		for (const customScale of [0, 6])
			expect(() =>
				prepareAgentEditPlan(fixture(), [
					{ type: "addZoom", args: { startSec: 2, endSec: 4, customScale } },
				]),
			).toThrow();
	});
	it("adds, changes, and removes imported audio clips with truthful stable change IDs", () => {
		const base = fixture();
		base.audioAssets = [
			{ id: "music", label: "Music", originalPath: "/music.wav", durationSec: 24 },
		];
		const first = prepareAgentEditPlan(base, [
			{
				type: "addAudioClip",
				args: {
					assetId: "music",
					startSec: 2,
					endSec: 10,
					sourceOffsetSec: 1,
					gain: 0.25,
					fadeInSec: 1,
					fadeOutSec: 2,
				},
			},
		]);
		const clip = first.candidate.timeline.audioClips![0];
		expect(first.changed_ids).toEqual([clip.id]);
		expect(first.changed_count).toBe(1);
		expect(clip).toMatchObject({ startSec: 2, endSec: 10, sourceOffsetSec: 1, gain: 0.25 });
		expect(Object.isFrozen(clip)).toBe(true);
		const changed = prepareAgentEditPlan(first.candidate, [
			{ type: "setAudioClip", args: { audioClipId: clip.id, gain: 0.5 } },
		]);
		expect(changed.candidate.timeline.audioClips![0]).toMatchObject({ ...clip, gain: 0.5 });
		expect(changed.changed_ids).toEqual([clip.id]);
		const removed = prepareAgentEditPlan(changed.candidate, [
			{ type: "removeAudioClip", args: { audioClipId: clip.id } },
		]);
		expect(removed.candidate.timeline.audioClips).toEqual([]);
		expect(removed.changed_ids).toEqual([clip.id]);
		expect(base.timeline.audioClips ?? []).toEqual([]);
	});
	it("rejects missing audio assets, source overflow, and path imports atomically", () => {
		const base = fixture();
		base.audioAssets = [
			{ id: "music", label: "Music", originalPath: "/music.wav", durationSec: 3 },
		];
		const bytes = JSON.stringify(base);
		for (const args of [
			{ assetId: "missing", startSec: 0, endSec: 2 },
			{ assetId: "music", startSec: 0, endSec: 4 },
			{ assetId: "music", startSec: 0, endSec: 2, originalPath: "/new.wav" },
			{ assetId: "music", startSec: 0, endSec: 2, fadeInSec: 2, fadeOutSec: 1 },
		]) {
			expect(() =>
				prepareAgentEditPlan(base, [
					{ type: "set-layout", settings: { padding: 20 } },
					{ type: "addAudioClip", args },
				]),
			).toThrow();
		}
		expect(JSON.stringify(base)).toBe(bytes);
	});
});

describe("removeTrims", () => {
	it("drops exactly the listed trims, leaving a touching trim from another source alone", () => {
		const base = fixture();
		const withTrims = prepareAgentEditPlan(base, [
			{ type: "addTrim", args: { clipId: "c", startSec: 2, endSec: 3, reason: "edge-silence" } },
			{ type: "addTrim", args: { clipId: "c", startSec: 3, endSec: 4, reason: "" } },
			{ type: "addTrim", args: { clipId: "c", startSec: 10, endSec: 11, reason: "edge-silence" } },
		]).candidate;
		const ids = withTrims.timeline.trimRanges.map((trim) => trim.id);
		const plan = prepareAgentEditPlan(withTrims, [
			{ type: "removeTrims", args: { trimRangeIds: [ids[0], ids[2]] } },
		]);
		expect(plan.candidate.timeline.trimRanges.map((trim) => trim.id)).toEqual([ids[1]]);
		expect(plan.results[0]).toEqual({ type: "removeTrims", result: { ids: [ids[0], ids[2]] } });
		expect(() =>
			prepareAgentEditPlan(withTrims, [{ type: "removeTrims", args: { trimRangeIds: ["nope"] } }]),
		).toThrow(/Unknown trim range: nope/);
	});
});

describe("splitClip", () => {
	it("splits a clip at a source time, keeps the left id and reports both ids", () => {
		const base = fixture();
		const plan = prepareAgentEditPlan(base, [
			{ type: "splitClip", args: { clipId: "c", sourceTimeSec: 10 } },
		]);
		const clips = plan.candidate.timeline.clips;
		expect(clips).toHaveLength(2);
		expect(clips[0]).toMatchObject({ id: "c", sourceStartSec: 0, sourceEndSec: 10 });
		expect(clips[1]).toMatchObject({ sourceStartSec: 10, sourceEndSec: 24, timelineStartSec: 10 });
		expect(plan.results[0]).toEqual({ type: "splitClip", result: { ids: ["c", clips[1].id] } });
		expect(base.timeline.clips).toHaveLength(1);
	});

	it("rejects split points outside or at the edges of the clip", () => {
		for (const sourceTimeSec of [0, 24, 30]) {
			expect(() =>
				prepareAgentEditPlan(fixture(), [
					{ type: "splitClip", args: { clipId: "c", sourceTimeSec } },
				]),
			).toThrow(/INVALID_RANGE/);
		}
		expect(() =>
			prepareAgentEditPlan(fixture(), [
				{ type: "splitClip", args: { clipId: "x", sourceTimeSec: 3 } },
			]),
		).toThrow(/UNKNOWN_CLIP/);
	});
});

describe("video overlays", () => {
	function withBroll() {
		const base = fixture();
		return documentSchema.parse({
			...base,
			assets: [
				...base.assets,
				{
					id: "broll",
					kind: "video",
					label: "B-roll",
					originalPath: "/broll.mp4",
					durationSec: 30,
					cameraTrack: null,
				},
			],
		});
	}

	it("adds an anchored overlay, edits it, and removes it", () => {
		const base = withBroll();
		const added = prepareAgentEditPlan(base, [
			{
				type: "addVideoOverlay",
				args: { assetId: "broll", startSec: 4, endSec: 10, sourceOffsetSec: 2 },
			},
		]);
		const overlay = (added.candidate.videoOverlays ?? [])[0];
		expect(overlay).toMatchObject({
			assetId: "broll",
			startMs: 4000,
			endMs: 10000,
			sourceOffsetSec: 2,
			fit: "cover",
			placement: null,
			opacity: 1,
			clipId: "c",
			sourceStartSec: 4,
			sourceEndSec: 10,
		});
		expect(added.results[0].result).toMatchObject({ ids: [overlay.id], fragments: 1 });
		expect(base.videoOverlays ?? []).toHaveLength(0);

		const edited = prepareAgentEditPlan(added.candidate, [
			{
				type: "setVideoOverlay",
				args: {
					videoOverlayId: overlay.id,
					endSec: 12,
					fit: "contain",
					placement: { x: 50, y: 0, width: 50, height: 50 },
				},
			},
		]);
		expect(edited.candidate.videoOverlays?.[0]).toMatchObject({
			id: overlay.id,
			endMs: 12000,
			fit: "contain",
			placement: { x: 50, y: 0, width: 50, height: 50 },
			sourceOffsetSec: 2,
		});

		const withNeighbour = prepareAgentEditPlan(edited.candidate, [
			{ type: "addVideoOverlay", args: { assetId: "broll", startSec: 12, endSec: 15 } },
		]);
		const removed = prepareAgentEditPlan(withNeighbour.candidate, [
			{ type: "removeVideoOverlay", args: { videoOverlayId: overlay.id } },
		]);
		expect((removed.candidate.videoOverlays ?? []).map((o) => o.startMs)).toEqual([12000]);
	});

	it("rejects unknown assets, spans past the video, and spans over no clip", () => {
		const base = withBroll();
		expect(() =>
			prepareAgentEditPlan(base, [
				{ type: "addVideoOverlay", args: { assetId: "nope", startSec: 0, endSec: 1 } },
			]),
		).toThrow(/UNKNOWN_ASSET/);
		expect(() =>
			prepareAgentEditPlan(base, [
				{
					type: "addVideoOverlay",
					args: { assetId: "broll", startSec: 0, endSec: 20, sourceOffsetSec: 15 },
				},
			]),
		).toThrow(/INVALID_RANGE/);
		expect(() =>
			prepareAgentEditPlan(base, [
				{ type: "addVideoOverlay", args: { assetId: "broll", startSec: 40, endSec: 41 } },
			]),
		).toThrow(/INVALID_RANGE/);
		expect(() =>
			prepareAgentEditPlan(base, [
				{ type: "removeVideoOverlay", args: { videoOverlayId: "missing" } },
			]),
		).toThrow(/UNKNOWN_VIDEO_OVERLAY/);
	});
});

describe("clip layout plans", () => {
	it("patches only specified values and clears overrides without changing project settings", () => {
		const base = fixture();
		base.clipLayouts = { c: { cameraShape: "squircle" } };
		const plan = prepareAgentEditPlan(base, [
			{
				type: "setClipLayout",
				clipId: "c",
				layout: { cameraAnchor: "bottom-right", cameraSize: "L", captions: false },
			},
		]);
		expect(plan.candidate.clipLayouts?.c).toEqual({
			cameraAnchor: "bottom-right",
			cameraSize: "L",
			cameraShape: "squircle",
			captions: false,
		});
		expect(plan.candidate.legacyEditor).toEqual(base.legacyEditor);
		expect(base.clipLayouts).toEqual({ c: { cameraShape: "squircle" } });
		expect(plan.settings_changed).toBe(true);
		const cleared = prepareAgentEditPlan(plan.candidate, [
			{ type: "setClipLayout", clipId: "c", layout: null },
		]);
		expect(cleared.candidate.clipLayouts?.c).toBeUndefined();
	});
	it("rejects missing clips and invalid override values atomically", () => {
		const base = fixture();
		expect(() =>
			prepareAgentEditPlan(base, [{ type: "setClipLayout", clipId: "missing", layout: {} }]),
		).toThrow("UNKNOWN_CLIP");
		expect(() =>
			prepareAgentEditPlan(base, [
				{ type: "setClipLayout", clipId: "c", layout: { cameraSize: 5 } },
			]),
		).toThrow();
		expect(base.clipLayouts).toBeUndefined();
	});
	it("accepts project names and numeric aliases, and rejects conflicting aliases", () => {
		const plan = prepareAgentEditPlan(fixture(), [
			{
				type: "set-layout",
				settings: {
					cameraAnchor: "bottom-right",
					cameraSize: "M",
					safeMarginPercent: 6,
					captions: true,
				},
			},
		]);
		expect(plan.candidate.legacyEditor).toMatchObject({
			cameraAnchor: "bottom-right",
			webcamSizePreset: 26,
			safeMarginPercent: 6,
			captions: { enabled: true },
		});
		const numeric = prepareAgentEditPlan(plan.candidate, [
			{ type: "set-layout", settings: { webcamPosition: { cx: 0.3, cy: 0.4 }, cameraSize: 31 } },
		]);
		expect(numeric.candidate.legacyEditor?.cameraAnchor).toBeUndefined();
		expect(numeric.candidate.legacyEditor).toMatchObject({
			webcamPosition: { cx: 0.3, cy: 0.4 },
			webcamSizePreset: 31,
		});
		expect(() =>
			prepareAgentEditPlan(fixture(), [
				{ type: "set-layout", settings: { cameraSize: "M", webcamSizePreset: 20 } },
			]),
		).toThrow();
	});
});

describe("clip layout final candidate validation", () => {
	it("rejects clip presets even when they match the project without mutating the base", () => {
		const base = fixture();
		base.legacyEditor = { ...base.legacyEditor, webcamLayoutPreset: "picture-in-picture" };
		const before = JSON.stringify(base);
		expect(() =>
			prepareAgentEditPlan(base, [
				{
					type: "setClipLayout",
					clipId: "c",
					layout: { cameraLayoutPreset: "picture-in-picture", cameraSize: "M" },
				},
			]),
		).toThrow("CLIP_LAYOUT_UNSUPPORTED");
		expect(JSON.stringify(base)).toBe(before);
	});

	it("rejects clip framing even when it matches the project", () => {
		const base = fixture();
		base.legacyEditor = {
			...base.legacyEditor,
			aspectRatio: "16:9",
			screenFramingByVariant: { "16:9": { scale: 1, focalPoint: { cx: 0.5, cy: 0.5 } } },
		};
		expect(() =>
			prepareAgentEditPlan(base, [
				{
					type: "setClipLayout",
					clipId: "c",
					layout: { screenFraming: { scale: 1, focalPoint: { cx: 0.5, cy: 0.5 } } },
				},
			]),
		).toThrow("CLIP_LAYOUT_UNSUPPORTED");
	});

	it("allows clearing externally authored unsupported overrides in a project edit batch", () => {
		const base = fixture();
		base.legacyEditor = { ...base.legacyEditor, webcamLayoutPreset: "picture-in-picture" };
		base.clipLayouts = {
			c: {
				cameraLayoutPreset: "picture-in-picture",
				screenFraming: { scale: 1, focalPoint: { cx: 0.5, cy: 0.5 } },
			},
		};
		const plan = prepareAgentEditPlan(base, [
			{ type: "set-layout", settings: { webcamLayoutPreset: "dual-frame" } },
			{ type: "setClipLayout", clipId: "c", layout: null },
		]);
		expect(plan.candidate.clipLayouts?.c).toBeUndefined();
		expect(getEditorSettings(plan.candidate).webcamLayoutPreset).toBe("dual-frame");
	});
});

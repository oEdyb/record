import { describe, expect, it } from "vitest";
import { buildResolvedEdit } from "../checks/context";
import { editFixture, word } from "../checks/fixtures";
import { resolveEffectiveState, resolveStateReport } from "./effectiveState";

describe("effective edit state", () => {
	it("reports named camera values, numbers and individual clip override layers", () => {
		const document = editFixture();
		document.legacyEditor = { webcamSizePreset: 26, webcamMaskShape: "squircle" };
		document.timeline.clips.push({
			...document.timeline.clips[0],
			id: "second",
			timelineStartSec: 20,
			timelineEndSec: 40,
		});
		document.clipLayouts = {
			second: { cameraAnchor: "bottom-right", cameraSize: "L", captions: false },
		};
		const context = buildResolvedEdit(document);
		const inherited = resolveEffectiveState(context, 1);
		const overridden = resolveEffectiveState(context, 21);
		expect(inherited.layout.cameraSize).toEqual({
			value: "M",
			percent: 26,
			fraction: 0.26,
			layer: "project",
		});
		expect(overridden.layout.cameraSize).toEqual({
			value: "L",
			percent: 34,
			fraction: 0.34,
			layer: "clip:second",
		});
		expect(overridden.layout.cameraAnchor).toMatchObject({
			value: "bottom-right",
			layer: "clip:second",
		});
		expect(overridden.layout.cameraAnchor.position).toEqual(overridden.layout.cameraPosition.value);
		expect(overridden.layout.cameraShape).toEqual({ value: "squircle", layer: "project" });
		expect(overridden.layout.screenFraming.layer).toBe("project");
		expect(overridden.layout.captions).toEqual({ value: false, layer: "clip:second" });
		expect(overridden.layout.cameraBaseRect.layer).toBe("clip:second");
	});
	it("resolves clip state at the first kept edited second and rejects unused clips", () => {
		const context = buildResolvedEdit(editFixture({ trims: [[0, 5]] }));
		expect(resolveStateReport(context, { clipId: "clip" }).state).toMatchObject({
			editedTimeSec: 0,
			sourceTimeSec: 5,
		});
		expect(() => resolveStateReport(context, { at: 0, clipId: "clip" })).toThrow("exactly one");
		expect(() =>
			resolveStateReport(buildResolvedEdit(editFixture({ trims: [[0, 20]] })), {
				clipId: "clip",
			}),
		).toThrow("no kept footage");
	});
	it("maps the edited transport through a trim and resolves snapped camera state", () => {
		const document = editFixture({
			trims: [[5, 10]],
			cameras: [{ id: "camera", start: 10.4, end: 13 }],
		});
		const context = buildResolvedEdit(document);
		const state = resolveEffectiveState(context, 5.1);
		expect(state.rawTimeSec).toBeCloseTo(10.1);
		expect(state.sourceTimeSec).toBeCloseTo(10.1);
		expect(state.clip.value?.id).toBe("clip");
		expect(state.regions[0]).toMatchObject({
			id: "camera",
			origin: "manual",
			layer: "project",
			edited: { startSec: 5, endSec: 8 },
		});
		expect(state.regions[0].remainingSec).toBeCloseTo(2.9);
		expect(state.cuts.previous?.distanceSec).toBeCloseTo(0.1);
		expect(state.layout.cameraBaseRect.value).toEqual(
			context.scene.layout.layoutByClip?.[1]?.webcamRect,
		);
	});
	it("uses half-open cut boundaries and splits ranges at region edges", () => {
		const context = buildResolvedEdit(
			editFixture({ trims: [[5, 10]], cameras: [{ id: "camera", start: 11, end: 13 }] }),
		);
		expect(resolveEffectiveState(context, 5).sourceTimeSec).toBe(10);
		const result = resolveStateReport(context, { at: 4, range: { startSec: 4, endSec: 9 } });
		expect(result.spans.map((item) => item.span)).toEqual([
			{ startSec: 4, endSec: 5 },
			{ startSec: 5, endSec: 6 },
			{ startSec: 6, endSec: 8 },
			{ startSec: 8, endSec: 9 },
		]);
		expect(() => resolveEffectiveState(context, 100)).toThrow("inside");
	});
	it("projects captions, annotations and video offsets through the same trim", () => {
		const document = editFixture({
			trims: [[5, 10]],
			words: [word("Visible", 11, 12), word("caption.", 12, 13)],
		});
		document.legacyEditor = { captions: { enabled: true } };
		document.assets.push({
			id: "broll",
			kind: "video",
			label: "B-roll",
			originalPath: "/broll.mp4",
			durationSec: 20,
			cameraTrack: null,
		});
		document.videoOverlays = [
			{
				id: "removed",
				assetId: "broll",
				startMs: 6000,
				endMs: 7000,
				sourceOffsetSec: 0,
				fit: "cover",
				placement: null,
				opacity: 1,
			},
			{
				id: "broll-region",
				assetId: "broll",
				startMs: 1000,
				endMs: 14000,
				sourceOffsetSec: 0,
				fit: "cover",
				placement: null,
				opacity: 1,
			},
		];
		document.annotations = [
			{
				id: "annotation",
				startMs: 1000,
				endMs: 14000,
				type: "text",
				content: "Card",
				position: { x: 10, y: 20 },
				size: { width: 50, height: 20 },
				style: {
					fontSize: 24,
					color: "#fff",
					backgroundColor: "transparent",
					fontFamily: "Inter",
					fontWeight: "normal",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "left",
				},
				zIndex: 1,
			},
		];
		const state = resolveEffectiveState(buildResolvedEdit(document), 6.5);
		expect(state.regions.find((region) => region.kind === "caption")?.value).toMatchObject({
			text: { content: "Visible caption." },
		});
		expect(state.regions.find((region) => region.id === "annotation")?.value).toMatchObject({
			x: 0.1,
			y: 0.2,
			w: 0.5,
			h: 0.2,
		});
		expect(state.regions.find((region) => region.id === "broll-region")?.value).toMatchObject({
			sourceOffsetSec: 9,
			path: "/broll.mp4",
		});
		expect(state.regions.some((region) => region.id === "removed")).toBe(false);
	});
	it("reports the regions at the renderer's clamped final source frame", () => {
		const context = buildResolvedEdit(
			editFixture({ cameras: [{ id: "camera", start: 1, end: 20 }] }),
		);
		const state = resolveEffectiveState(context, 20);
		expect(state.sourceTimeSec).toBe(19.967);
		expect(state.regions[0]).toMatchObject({ id: "camera", remainingSec: 0 });
		expect(state.layout.geometryScope.value).toContain("scene base");
		expect(state.layout.cameraMode.value).toBe("fullscreen");
	});
	it("keeps split ids stable and applies renderer zoom settings", () => {
		const document = editFixture({ trims: [[5, 10]] });
		document.zoomRanges = [
			{
				id: "zoom",
				startMs: 1000,
				endMs: 13000,
				depth: 2,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
			},
		];
		document.legacyEditor = { autoFocusAll: true };
		const state = resolveEffectiveState(buildResolvedEdit(document), 6);
		expect(state.regions[0]).toMatchObject({
			id: "zoom",
			value: { id: "zoom", focusMode: "auto" },
		});
		expect(resolveEffectiveState(buildResolvedEdit(document), 6)).toEqual(state);
	});
});

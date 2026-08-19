import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { ZOOM_IN_OVERLAP_MS, ZOOM_IN_TRANSITION_WINDOW_MS } from "@/lib/zoomMath/constants";
import {
	buildZoomPlaybackSegments,
	buildZoomTimelineEnvelopes,
	computeZoomPreviewTransform,
} from "./zoom-preview";

const zoom = (id: string, startMs: number, endMs: number, cx: number): AxcutZoomRegion => ({
	id,
	startMs,
	endMs,
	depth: 2,
	customScale: 1.5,
	focus: { cx, cy: 0.5 },
	focusMode: "manual",
});

describe("zoom preview motion", () => {
	it("pans smoothly between nearby regions without zooming out", () => {
		const regions = [zoom("left", 1_000, 3_000, 0.2), zoom("right", 4_000, 6_000, 0.8)];
		const start = computeZoomPreviewTransform(regions, 3_000);
		const middle = computeZoomPreviewTransform(regions, 3_500);
		const end = computeZoomPreviewTransform(regions, 4_000);

		expect(start.scale).toBeCloseTo(1.5, 5);
		expect(middle.scale).toBeCloseTo(1.5, 5);
		expect(end.scale).toBeCloseTo(1.5, 5);
		expect(middle.translateXPercent).toBeLessThan(start.translateXPercent);
		expect(middle.translateXPercent).toBeGreaterThan(end.translateXPercent);
	});

	it("uses the incoming region's speed for a connected pan", () => {
		const left = { ...zoom("left-speed", 1_000, 3_000, 0.2), motionStyle: "linear" as const };
		const right = { ...zoom("right-speed", 4_000, 6_000, 0.8), motionStyle: "linear" as const };
		const normal = computeZoomPreviewTransform([left, right], 3_250);
		const fast = computeZoomPreviewTransform([left, { ...right, motionSpeed: 2 }], 3_250);

		expect(fast.translateXPercent).toBeLessThan(normal.translateXPercent);
	});

	it("does not connect Zoom regions across a removed playback segment", () => {
		const clip: AxcutClip = {
			id: "clip_1",
			assetId: "asset_1",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "",
		};
		const segments = buildZoomPlaybackSegments(
			[clip],
			[
				{
					id: "trim_1",
					assetId: "asset_1",
					clipId: "clip_1",
					startSec: 3.2,
					endSec: 3.8,
					reason: "Removed",
					origin: "user",
				},
			],
		);
		const left = { ...zoom("left-trim", 1_000, 3_000, 0.2), motionStyle: "linear" as const };
		const right = { ...zoom("right-trim", 4_000, 6_000, 0.8), motionStyle: "linear" as const };
		const connected = computeZoomPreviewTransform([left, right], 3_800);
		const afterTrim = computeZoomPreviewTransform([left, right], 3_800, undefined, segments);
		const nativeEquivalent = computeZoomPreviewTransform([right], 3_800);
		const envelopes = buildZoomTimelineEnvelopes([left, right], segments);

		expect(segments).toEqual([
			{ startMs: 0, endMs: 3_200 },
			{ startMs: 3_800, endMs: 10_000 },
		]);
		expect(afterTrim).toEqual(nativeEquivalent);
		expect(afterTrim.scale).toBeLessThan(connected.scale);
		expect(envelopes).toHaveLength(2);
		expect(envelopes[0].endMs).toBeLessThanOrEqual(3_200);
		expect(envelopes[1].startMs).toBeGreaterThanOrEqual(3_800);
	});

	it("keeps adjacent clip boundaries as hard envelope barriers", () => {
		const clips: AxcutClip[] = [
			{
				id: "clip_1",
				assetId: "asset_1",
				sourceStartSec: 0,
				sourceEndSec: 3,
				timelineStartSec: 0,
				timelineEndSec: 3,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
			{
				id: "clip_2",
				assetId: "asset_2",
				sourceStartSec: 0,
				sourceEndSec: 3,
				timelineStartSec: 3,
				timelineEndSec: 6,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		];
		const envelopes = buildZoomTimelineEnvelopes(
			[zoom("left-clip", 1_000, 3_000, 0.2), zoom("right-clip", 3_000, 5_000, 0.8)],
			buildZoomPlaybackSegments(clips, []),
		);

		expect(envelopes).toHaveLength(2);
		expect(envelopes[0].endMs).toBe(3_000);
		expect(envelopes[1].startMs).toBe(3_000);
	});

	it("does not show or preview Zoom motion when every frame is trimmed", () => {
		const clip: AxcutClip = {
			id: "clip_fully_trimmed",
			assetId: "asset_fully_trimmed",
			sourceStartSec: 0,
			sourceEndSec: 3,
			timelineStartSec: 0,
			timelineEndSec: 3,
			wordRefs: [],
			origin: "user",
			reason: "",
		};
		const segments = buildZoomPlaybackSegments(
			[clip],
			[
				{
					id: "trim_all",
					assetId: clip.assetId,
					clipId: clip.id,
					startSec: 0,
					endSec: 3,
					reason: "Removed",
					origin: "user",
				},
			],
		);
		const hiddenZoom = zoom("hidden", 500, 2_500, 0.5);

		expect(segments).toEqual([]);
		expect(buildZoomTimelineEnvelopes([hiddenZoom], segments)).toEqual([]);
		expect(computeZoomPreviewTransform([hiddenZoom], 1_500, undefined, segments)).toEqual({
			scale: 1,
			translateXPercent: 0,
			translateYPercent: 0,
		});
	});

	it("uses each region's authored motion style", () => {
		const base = zoom("motion", 1_000, 4_000, 0.5);
		const atLeadInQuarter = base.startMs + ZOOM_IN_OVERLAP_MS - ZOOM_IN_TRANSITION_WINDOW_MS * 0.75;
		const smooth = computeZoomPreviewTransform(
			[{ ...base, motionStyle: "smooth" }],
			atLeadInQuarter,
		);
		const linear = computeZoomPreviewTransform(
			[{ ...base, motionStyle: "linear" }],
			atLeadInQuarter,
		);
		const instant = computeZoomPreviewTransform(
			[{ ...base, motionStyle: "instant" }],
			atLeadInQuarter,
		);

		expect(smooth.scale).toBeLessThan(linear.scale);
		expect(linear.scale).toBeCloseTo(1.125, 5);
		expect(instant.scale).toBeCloseTo(1.5, 5);
	});

	it("preserves each region's authored motion speed in the preview adapter", () => {
		const base = zoom("motion-speed", 2_000, 5_000, 0.5);
		const fastWindow = ZOOM_IN_TRANSITION_WINDOW_MS / 2;
		const fastLeadInStart = base.startMs + ZOOM_IN_OVERLAP_MS - fastWindow;
		const quarter = computeZoomPreviewTransform(
			[{ ...base, motionStyle: "linear", motionSpeed: 2 }],
			fastLeadInStart + fastWindow * 0.25,
		);

		expect(quarter.scale).toBeCloseTo(1.125, 5);
	});
});

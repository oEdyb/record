import { describe, expect, it } from "vitest";
import type { ZoomRegion } from "@/components/video-editor/types";
import {
	TRANSITION_WINDOW_MS,
	ZOOM_IN_OVERLAP_MS,
	ZOOM_IN_TRANSITION_WINDOW_MS,
} from "./constants";
import {
	buildZoomVisualEnvelopes,
	computeRegionStrength,
	findDominantRegion,
} from "./zoomRegionUtils";

const region: ZoomRegion = {
	id: "zoom-motion",
	startMs: 2_000,
	endMs: 6_000,
	depth: 3,
	focus: { cx: 0.5, cy: 0.5 },
};

const leadInStart = region.startMs + ZOOM_IN_OVERLAP_MS - ZOOM_IN_TRANSITION_WINDOW_MS;
const atLeadInQuarter = leadInStart + ZOOM_IN_TRANSITION_WINDOW_MS * 0.25;

describe("zoom region motion profiles", () => {
	it("describes the full visible envelope outside the stored Zoom body", () => {
		const fast = {
			...region,
			startMs: 2_098,
			endMs: 2_517,
			motionSpeed: 2 as const,
		};
		const [envelope] = buildZoomVisualEnvelopes([fast]);

		expect(envelope.regionIds).toEqual([fast.id]);
		expect(envelope.startMs).toBeCloseTo(
			fast.startMs + ZOOM_IN_OVERLAP_MS - ZOOM_IN_TRANSITION_WINDOW_MS / 2,
			8,
		);
		expect(envelope.endMs).toBeCloseTo(fast.endMs + TRANSITION_WINDOW_MS / 2, 8);
		expect(envelope.startMs).toBeLessThan(fast.startMs);
		expect(envelope.endMs).toBeGreaterThan(fast.endMs);
	});

	it("uses one visible envelope across a connected-pan gap", () => {
		const first = { ...region, id: "first", startMs: 2_098, endMs: 2_517 };
		const second = { ...region, id: "second", startMs: 3_017, endMs: 3_705 };

		expect(buildZoomVisualEnvelopes([first, second])).toEqual([
			expect.objectContaining({ regionIds: ["first", "second"] }),
		]);
	});

	it("does not connect different authored direction passages only because they are close", () => {
		const first = {
			...region,
			id: "first",
			startMs: 1_000,
			endMs: 3_000,
			focus: { cx: 0.68, cy: 0.5 },
			directionGroupId: "passage-a",
		};
		const second = {
			...region,
			id: "second",
			startMs: 3_706,
			endMs: 5_500,
			focus: { cx: 0.5, cy: 0.5 },
			directionGroupId: "passage-b",
		};

		expect(buildZoomVisualEnvelopes([first, second])).toHaveLength(2);
		expect(
			findDominantRegion([first, second], 3_800, { connectZooms: true }).transition,
		).toBeNull();
		expect(
			buildZoomVisualEnvelopes([first, { ...second, directionGroupId: undefined }]),
		).toHaveLength(2);
	});

	it("keeps connected pans inside one authored direction passage", () => {
		const first = {
			...region,
			id: "first",
			startMs: 1_000,
			endMs: 3_000,
			directionGroupId: "passage-a",
		};
		const second = {
			...region,
			id: "second",
			startMs: 3_500,
			endMs: 5_500,
			directionGroupId: "passage-a",
		};

		expect(buildZoomVisualEnvelopes([first, second])).toEqual([
			expect.objectContaining({ regionIds: ["first", "second"] }),
		]);
	});

	it("uses the same inclusive 1500 ms connection boundary as the renderer", () => {
		const first = { ...region, id: "first", startMs: 0, endMs: 1_000 };
		const atBoundary = { ...region, id: "at-boundary", startMs: 2_500, endMs: 4_000 };
		const pastBoundary = { ...atBoundary, id: "past-boundary", startMs: 2_501 };

		expect(buildZoomVisualEnvelopes([first, atBoundary])).toHaveLength(1);
		expect(buildZoomVisualEnvelopes([first, pastBoundary])).toHaveLength(2);
	});

	it("preserves Snappy when an older zoom has no stored motion style", () => {
		expect(computeRegionStrength(region, atLeadInQuarter)).toBeGreaterThan(0.8);
	});

	it("lets one zoom choose a snappier curve independently", () => {
		expect(
			computeRegionStrength({ ...region, motionStyle: "snappy" }, atLeadInQuarter),
		).toBeGreaterThan(0.8);
	});

	it("turns Instant into a deterministic cut at both region boundaries", () => {
		const instant = { ...region, motionStyle: "instant" as const };
		expect(computeRegionStrength(instant, leadInStart)).toBe(0);
		expect(computeRegionStrength(instant, leadInStart + 1)).toBe(1);
		expect(computeRegionStrength(instant, region.endMs)).toBe(1);
		expect(computeRegionStrength(instant, region.endMs + 1)).toBe(0);
	});

	it("shortens every transition window when one zoom uses a faster motion speed", () => {
		const fast = { ...region, motionStyle: "linear" as const, motionSpeed: 2 as const };
		const fastWindow = ZOOM_IN_TRANSITION_WINDOW_MS / 2;
		const fastLeadInStart = region.startMs + ZOOM_IN_OVERLAP_MS - fastWindow;

		expect(computeRegionStrength(fast, fastLeadInStart)).toBe(0);
		expect(computeRegionStrength(fast, fastLeadInStart + fastWindow * 0.25)).toBeCloseTo(0.25, 8);
		expect(computeRegionStrength(fast, region.endMs + TRANSITION_WINDOW_MS / 4)).toBeCloseTo(
			0.5,
			8,
		);
	});

	it("uses the incoming region speed for a connected pan", () => {
		const regions: ZoomRegion[] = [
			{
				...region,
				id: "left",
				startMs: 1_000,
				endMs: 3_000,
				focus: { cx: 0.32, cy: 0.5 },
				customScale: 1.65,
				motionStyle: "smooth",
			},
			{
				...region,
				id: "right",
				startMs: 3_500,
				endMs: 5_500,
				focus: { cx: 0.68, cy: 0.5 },
				customScale: 1.65,
				motionStyle: "smooth",
				motionSpeed: 2,
			},
		];

		const halfway = findDominantRegion(regions, 3_250, { connectZooms: true });
		const arrived = findDominantRegion(regions, 3_500, { connectZooms: true });

		expect(halfway.region?.focus.cx).toBeCloseTo(0.5, 4);
		expect(arrived.region?.focus.cx).toBeCloseTo(0.68, 4);
		expect(arrived.strength).toBe(1);
	});

	it("keeps full strength after a connected pan reaches the incoming region", () => {
		const regions: ZoomRegion[] = [
			{
				...region,
				id: "typing-click",
				startMs: 1_000,
				endMs: 3_000,
				focus: { cx: 0.58, cy: 0.6 },
				customScale: 1.264,
				motionStyle: "smooth",
			},
			{
				...region,
				id: "typing-caret",
				startMs: 3_500,
				endMs: 5_500,
				focus: { cx: 0.6, cy: 0.5 },
				customScale: 1.264,
				motionStyle: "smooth",
				motionSpeed: 2,
			},
		];

		const arrival = findDominantRegion(regions, 3_500, { connectZooms: true });
		const nextFrame = findDominantRegion(regions, 3_501, { connectZooms: true });

		expect(arrival.strength).toBe(1);
		expect(nextFrame.strength).toBe(1);
		expect(nextFrame.blendedScale ?? 1.264).toBeCloseTo(1.264);
		const leadOut = findDominantRegion(regions, 5_750, { connectZooms: true });
		expect(leadOut.strength).toBeGreaterThan(0);
		expect(leadOut.strength).toBeLessThan(1);
	});

	it("starts the final lead-out when a connected incoming region is short", () => {
		const regions: ZoomRegion[] = [
			{
				...region,
				id: "left",
				startMs: 1_000,
				endMs: 3_000,
				customScale: 1.264,
			},
			{
				...region,
				id: "short-right",
				startMs: 3_500,
				endMs: 3_600,
				customScale: 1.264,
				motionSpeed: 0.5,
			},
		];

		const afterEnd = findDominantRegion(regions, 3_700, { connectZooms: true });

		expect(afterEnd.transition).toBeNull();
		expect(afterEnd.strength).toBeGreaterThan(0);
		expect(afterEnd.strength).toBeLessThan(1);
	});

	it("does not connect a region contained inside a longer region", () => {
		const regions: ZoomRegion[] = [
			{
				...region,
				id: "long",
				startMs: 1_000,
				endMs: 5_000,
				focus: { cx: 0.2, cy: 0.5 },
			},
			{
				...region,
				id: "contained",
				startMs: 2_000,
				endMs: 3_000,
				focus: { cx: 0.8, cy: 0.5 },
			},
		];

		const active = findDominantRegion(regions, 2_500, { connectZooms: true });

		expect(active.region?.id).toBe("contained");
		expect(active.region?.focus.cx).toBeGreaterThan(0.6);
	});
});

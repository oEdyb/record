import { describe, expect, it } from "vitest";
import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import {
	cameraTransitionTiming,
	computeCameraDriftFactor,
	computeCameraFullscreenProgress,
	computeCameraLayoutState,
} from "./cameraFullscreenUtils";
import { TRANSITION_WINDOW_MS } from "./constants";

function makeRegion(startMs: number, endMs: number): CameraFullscreenRegion {
	return { id: `camera-${startMs}-${endMs}`, startMs, endMs };
}

describe("computeCameraFullscreenProgress", () => {
	it("returns 0 for an empty regions array", () => {
		expect(computeCameraFullscreenProgress([], 1000)).toBe(0);
	});

	it("returns 0 well outside any region", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], 0)).toBe(0);
		expect(computeCameraFullscreenProgress([region], 20000)).toBe(0);
	});

	it("returns exactly 0 at startMs and at endMs", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], region.startMs)).toBe(0);
		expect(computeCameraFullscreenProgress([region], region.endMs)).toBe(0);
	});

	it("returns 1 in the middle (hold) of a region", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], 6500)).toBe(1);
	});

	it("holds at 1 for the full duration between the lead-in and lead-out windows", () => {
		const region = makeRegion(1000, 5000);
		const leadInEnd = region.startMs + TRANSITION_WINDOW_MS;
		const leadOutStart = region.endMs - TRANSITION_WINDOW_MS * 1.5;
		expect(computeCameraFullscreenProgress([region], leadInEnd)).toBeCloseTo(1, 5);
		expect(computeCameraFullscreenProgress([region], leadOutStart)).toBeCloseTo(1, 5);
		expect(computeCameraFullscreenProgress([region], (leadInEnd + leadOutStart) / 2)).toBe(1);
	});

	it("eases in from 0 (at startMs) toward 1 entirely within the region", () => {
		const region = makeRegion(5000, 8000);
		const leadInEnd = region.startMs + TRANSITION_WINDOW_MS;

		const atStart = computeCameraFullscreenProgress([region], region.startMs);
		const midway = computeCameraFullscreenProgress([region], (region.startMs + leadInEnd) / 2);
		const atLeadInEnd = computeCameraFullscreenProgress([region], leadInEnd);

		expect(atStart).toBe(0);
		expect(midway).toBeGreaterThan(0);
		expect(midway).toBeLessThan(1);
		expect(atLeadInEnd).toBeCloseTo(1, 5);
		// Monotonically increasing during ease-in.
		expect(midway).toBeGreaterThan(atStart);
		expect(atLeadInEnd).toBeGreaterThan(midway);
	});

	it("eases out from 1 toward 0, landing exactly at endMs", () => {
		const region = makeRegion(5000, 8000);
		const leadOutWindow = Math.min(TRANSITION_WINDOW_MS * 1.5, (region.endMs - region.startMs) / 2);
		const leadOutStart = region.endMs - leadOutWindow;

		const atLeadOutStart = computeCameraFullscreenProgress([region], leadOutStart);
		const midway = computeCameraFullscreenProgress([region], (leadOutStart + region.endMs) / 2);
		const atEndMs = computeCameraFullscreenProgress([region], region.endMs);

		expect(atLeadOutStart).toBeCloseTo(1, 5);
		expect(midway).toBeGreaterThan(0);
		expect(midway).toBeLessThan(1);
		expect(atEndMs).toBe(0);
		// Monotonically decreasing during ease-out.
		expect(midway).toBeLessThan(atLeadOutStart);
		expect(atEndMs).toBeLessThan(midway);
	});

	it("eases out over a longer window than it eases in (slower return to normal)", () => {
		// Long region so neither window is clamped: lead-in is TRANSITION_WINDOW_MS,
		// lead-out is 1.5x that. At TRANSITION_WINDOW_MS from the start the ease-in has
		// finished, but at the mirrored offset from the end the ease-out is still going.
		const region = makeRegion(5000, 15000);
		const atLeadInEnd = computeCameraFullscreenProgress(
			[region],
			region.startMs + TRANSITION_WINDOW_MS,
		);
		const mirroredNearEnd = computeCameraFullscreenProgress(
			[region],
			region.endMs - TRANSITION_WINDOW_MS,
		);
		expect(atLeadInEnd).toBeCloseTo(1, 5);
		expect(mirroredNearEnd).toBeLessThan(1);
		expect(mirroredNearEnd).toBeGreaterThan(0);
	});

	it("returns exactly 0 just past endMs and just before startMs", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], region.endMs + 1)).toBe(0);
		expect(computeCameraFullscreenProgress([region], region.startMs - 1)).toBe(0);
	});

	it("clamps the transition windows to half the region duration for short regions", () => {
		// Region shorter than 2x TRANSITION_WINDOW_MS: lead-in and lead-out windows must
		// each shrink to half the duration so they still meet exactly at the midpoint,
		// staying fully contained within [startMs, endMs].
		const region = makeRegion(1000, 1000 + TRANSITION_WINDOW_MS); // duration < 2x window
		const midpoint = (region.startMs + region.endMs) / 2;

		expect(computeCameraFullscreenProgress([region], region.startMs)).toBe(0);
		expect(computeCameraFullscreenProgress([region], region.endMs)).toBe(0);
		expect(computeCameraFullscreenProgress([region], midpoint)).toBeCloseTo(1, 5);
	});

	it("picks the strongest of multiple overlapping regions", () => {
		// Two regions that don't normally overlap in the UI, but the function should be
		// defensive: whichever region yields the higher strength wins for that instant.
		const early = makeRegion(0, 2000);
		const late = makeRegion(1800, 5000);
		const timeMs = 1900; // inside early's ease-out and late's ease-in
		const combinedStrongest = Math.max(
			computeCameraFullscreenProgress([early], timeMs),
			computeCameraFullscreenProgress([late], timeMs),
		);
		expect(computeCameraFullscreenProgress([early, late], timeMs)).toBeCloseTo(
			combinedStrongest,
			10,
		);
	});

	it("handles multiple disjoint regions independently", () => {
		const first = makeRegion(0, 1000);
		const second = makeRegion(10000, 12000);
		expect(computeCameraFullscreenProgress([first, second], 500)).toBe(1);
		expect(computeCameraFullscreenProgress([first, second], 5000)).toBe(0);
		expect(computeCameraFullscreenProgress([first, second], 11000)).toBe(1);
	});
});

describe("computeCameraLayoutState", () => {
	it("keeps legacy regions as Full Camera", () => {
		expect(computeCameraLayoutState([makeRegion(0, 4000)], 2000)).toEqual({
			progress: 1,
			mode: "fullscreen",
			cameraScale: 1,
			driftScale: 1,
		});
	});

	it("returns a bounded emphasis target without leaking into Full Camera progress", () => {
		const emphasis: CameraFullscreenRegion = {
			...makeRegion(0, 4000),
			mode: "emphasis",
			cameraScale: 1.35,
		};
		expect(computeCameraLayoutState([emphasis], 2000)).toEqual({
			progress: 1,
			mode: "emphasis",
			cameraScale: 1.35,
			driftScale: 1,
		});
		expect(computeCameraFullscreenProgress([emphasis], 2000)).toBe(0);
	});

	it("lets camera motion differ from screen zoom motion", () => {
		const startMs = 5_000;
		const endMs = 10_000;
		const atQuarter = startMs + TRANSITION_WINDOW_MS * 0.25;
		const smooth = {
			...makeRegion(startMs, endMs),
			mode: "emphasis" as const,
			motionStyle: "smooth" as const,
		};
		const snappy = { ...smooth, motionStyle: "snappy" as const };
		const instant = { ...smooth, motionStyle: "instant" as const };

		expect(computeCameraLayoutState([smooth], atQuarter).progress).toBeCloseTo(0.103515625, 8);
		expect(computeCameraLayoutState([snappy], atQuarter).progress).toBeGreaterThan(0.8);
		expect(computeCameraLayoutState([instant], startMs - 1)).toHaveProperty("progress", 0);
		expect(computeCameraLayoutState([instant], startMs)).toHaveProperty("progress", 1);
		expect(computeCameraLayoutState([instant], endMs - 1)).toHaveProperty("progress", 1);
		expect(computeCameraLayoutState([instant], endMs)).toHaveProperty("progress", 0);
	});

	it("preserves Snappy when an older camera region has no stored motion style", () => {
		const legacy = { ...makeRegion(5_000, 10_000), mode: "emphasis" as const };
		const atQuarter = legacy.startMs + TRANSITION_WINDOW_MS * 0.25;

		expect(computeCameraLayoutState([legacy], atQuarter).progress).toBeGreaterThan(0.8);
	});

	it("shortens the contained camera transition when its motion speed increases", () => {
		const fast: CameraFullscreenRegion = {
			...makeRegion(5_000, 10_000),
			mode: "emphasis",
			motionStyle: "linear",
			motionSpeed: 2,
		};
		const atFastQuarter = fast.startMs + (TRANSITION_WINDOW_MS / 2) * 0.25;

		expect(computeCameraLayoutState([fast], atFastQuarter).progress).toBeCloseTo(0.25, 8);
	});
});

describe("cameraTransitionTiming", () => {
	it("clamps each phase to half a short region", () => {
		expect(cameraTransitionTiming(makeRegion(5800, 6900))).toEqual({
			leadInWindow: 550,
			leadOutWindow: 550,
			leadInEnd: 6350,
			leadOutStart: 6350,
		});
	});
	it("has no transition duration for an instant region", () => {
		const region = { ...makeRegion(2000, 6000), motionStyle: "instant" as const };
		expect(cameraTransitionTiming(region)).toEqual({
			leadInWindow: 0,
			leadOutWindow: 0,
			leadInEnd: 2000,
			leadOutStart: 6000,
		});
		expect(computeCameraLayoutState([region], 1999).progress).toBe(0);
		expect(computeCameraLayoutState([region], 2000).progress).toBe(1);
		expect(computeCameraLayoutState([region], 5999).progress).toBe(1);
		expect(computeCameraLayoutState([region], 6000).progress).toBe(0);
	});
});

describe("computeCameraDriftFactor", () => {
	const region: CameraFullscreenRegion = {
		...makeRegion(1000, 6000),
		drift: { scaleTo: 1.2, releaseSec: 0.5 },
	};

	it("pushes in slowly, then releases fast to exactly 1 at the end", () => {
		expect(computeCameraDriftFactor(region, 1000)).toBe(1);
		expect(computeCameraDriftFactor(region, 3250)).toBeCloseTo(1.1, 3);
		expect(computeCameraDriftFactor(region, 5500)).toBeCloseTo(1.2, 3);
		expect(computeCameraDriftFactor(region, 5750)).toBeCloseTo(1.05, 3);
		expect(computeCameraDriftFactor(region, 6000)).toBe(1);
		expect(computeCameraDriftFactor(makeRegion(1000, 6000), 3000)).toBe(1);
	});

	it("fades the drift with the region envelope in the layout state", () => {
		expect(computeCameraLayoutState([region], 1000).driftScale).toBe(1);
		expect(computeCameraLayoutState([region], 3000).driftScale).toBeCloseTo(
			computeCameraDriftFactor(region, 3000),
			6,
		);
		expect(computeCameraLayoutState([makeRegion(1000, 6000)], 3000).driftScale).toBe(1);
	});
});

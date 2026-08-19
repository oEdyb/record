import { describe, expect, it } from "vitest";
import {
	applyMotionCurve,
	DEFAULT_CAMERA_MOTION_STYLE,
	DEFAULT_ZOOM_MOTION_STYLE,
	isMotionSpeed,
	MOTION_STYLE_VALUES,
	NEW_CAMERA_MOTION_STYLE,
	NEW_ZOOM_MOTION_STYLE,
	normalizeMotionSpeed,
} from "./motionCurve";

describe("authored motion curves", () => {
	it("keeps the complete editor-facing profile set stable", () => {
		expect(MOTION_STYLE_VALUES).toEqual(["smooth", "snappy", "linear", "instant"]);
	});

	it("preserves legacy motion while new regions opt into Smooth", () => {
		expect(DEFAULT_ZOOM_MOTION_STYLE).toBe("snappy");
		expect(DEFAULT_CAMERA_MOTION_STYLE).toBe("snappy");
		expect(NEW_ZOOM_MOTION_STYLE).toBe("smooth");
		expect(NEW_CAMERA_MOTION_STYLE).toBe("smooth");
	});

	it("uses a zero-velocity smootherstep curve for professional smooth motion", () => {
		expect(applyMotionCurve("smooth", 0)).toBe(0);
		expect(applyMotionCurve("smooth", 0.1)).toBeCloseTo(0.00856, 5);
		expect(applyMotionCurve("smooth", 0.5)).toBeCloseTo(0.5, 10);
		expect(applyMotionCurve("smooth", 0.9)).toBeCloseTo(0.99144, 5);
		expect(applyMotionCurve("smooth", 1)).toBe(1);
	});

	it("keeps the current fast-settling curve as the separate snappy choice", () => {
		expect(applyMotionCurve("snappy", 0.1)).toBeGreaterThan(0.45);
		expect(applyMotionCurve("snappy", 0.25)).toBeGreaterThan(0.8);
		expect(applyMotionCurve("snappy", 1)).toBe(1);
	});

	it("supports uniform and cut-style interpolation without special render paths", () => {
		expect(applyMotionCurve("linear", 0.25)).toBe(0.25);
		expect(applyMotionCurve("linear", 0.75)).toBe(0.75);
		expect(applyMotionCurve("instant", 0)).toBe(0);
		expect(applyMotionCurve("instant", Number.EPSILON)).toBe(1);
		expect(applyMotionCurve("instant", 1)).toBe(1);
	});

	it("clamps every profile to the authored zero-to-one interval", () => {
		for (const style of MOTION_STYLE_VALUES) {
			expect(applyMotionCurve(style, -1)).toBe(0);
			expect(applyMotionCurve(style, 2)).toBe(1);
		}
	});

	it("accepts only the six speeds that the editor can display", () => {
		for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
			expect(isMotionSpeed(speed)).toBe(true);
		}
		expect(isMotionSpeed(1.1)).toBe(false);
		expect(isMotionSpeed("fast")).toBe(false);
	});

	it("normalizes malformed or custom values to a displayed motion speed", () => {
		expect(normalizeMotionSpeed(undefined)).toBe(1);
		expect(normalizeMotionSpeed(Number.NaN)).toBe(1);
		expect(normalizeMotionSpeed(0.1)).toBe(0.5);
		expect(normalizeMotionSpeed(1.1)).toBe(1);
		expect(normalizeMotionSpeed(1.25)).toBe(1.25);
		expect(normalizeMotionSpeed(9)).toBe(2);
	});
});

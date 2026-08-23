import { describe, expect, it } from "vitest";
import {
	dragScreenFocalPoint,
	normalizeScreenFraming,
	normalizeScreenFramingByVariant,
	screenFramingVariantKey,
	screenVisibleFractions,
} from "./screenFraming";

describe("screen framing", () => {
	it("normalizes persisted scale and focal points", () => {
		expect(normalizeScreenFraming({ scale: 8, focalPoint: { cx: -1, cy: 2 } })).toEqual({
			scale: 4,
			focalPoint: { cx: 0, cy: 1 },
		});
		expect(normalizeScreenFraming(null)).toEqual({
			scale: 1,
			focalPoint: { cx: 0.5, cy: 0.5 },
		});
	});

	it("keeps framing separate by output shape", () => {
		const normalized = normalizeScreenFramingByVariant({
			"16:9": { scale: 1.2, focalPoint: { cx: 0.25, cy: 0.5 } },
			"9:16": { scale: 2, focalPoint: { cx: 0.8, cy: 0.2 } },
		});
		expect(normalized["16:9"].scale).toBe(1.2);
		expect(normalized["9:16"].focalPoint).toEqual({ cx: 0.8, cy: 0.2 });
		expect(screenFramingVariantKey("9:16", { width: 2160, height: 3840 })).toBe("9:16");
	});

	it("uses cover as the minimum framing window", () => {
		expect(
			screenVisibleFractions({
				sourceWidth: 1920,
				sourceHeight: 1080,
				boxWidth: 900,
				boxHeight: 800,
				cover: true,
				scale: 1,
			}),
		).toEqual({ width: 0.6328125, height: 1 });
	});

	it("moves the focal point opposite the grabbed content", () => {
		const point = dragScreenFocalPoint({
			start: { cx: 0.5, cy: 0.5 },
			deltaX: 100,
			deltaY: 100,
			boxWidth: 500,
			boxHeight: 500,
			visible: { width: 0.5, height: 1 },
		});
		expect(point.cx).toBeCloseTo(0.3);
		expect(point.cy).toBe(0.5);
	});
});

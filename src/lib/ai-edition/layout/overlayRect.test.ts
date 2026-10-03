import { describe, expect, it } from "vitest";
import { CAMERA_ANCHORS, overlayRect } from "./vocabulary";

describe("overlay vocabulary", () => {
	it.each(CAMERA_ANCHORS)("keeps text and B-roll inside safe margins at %s", (anchor) => {
		for (const kind of ["text", "broll"] as const) {
			const rect = overlayRect(kind, anchor, "M", { width: 1920, height: 1080 }, 4);
			expect(rect.x).toBeGreaterThanOrEqual(2.25 - 0.0001);
			expect(rect.y).toBeGreaterThanOrEqual(4 - 0.0001);
			expect(rect.x + rect.width).toBeLessThanOrEqual(97.75 + 0.0001);
			expect(rect.y + rect.height).toBeLessThanOrEqual(96 + 0.0001);
		}
	});
	it("centers the box and makes labels smaller than cards", () => {
		const canvas = { width: 1920, height: 1080 };
		const card = overlayRect("text", "center", "M", canvas);
		expect(card.x + card.width / 2).toBeCloseTo(50);
		expect(card.y + card.height / 2).toBeCloseTo(50);
		expect(overlayRect("text", "center", "M", canvas, 4, "label").height).toBeLessThan(card.height);
	});
});

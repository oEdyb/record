import { describe, expect, it } from "vitest";
import { clampHudDragPosition } from "./hudDragGeometry";

const display = {
	bounds: { x: 0, y: 0, width: 1440, height: 932 },
	workArea: { x: 0, y: 25, width: 1440, height: 875 },
};
const size = { width: 940, height: 782 };

describe("clampHudDragPosition", () => {
	it("leaves a drag inside the screen alone", () => {
		expect(clampHudDragPosition({ x: 250, y: 100 }, size, display)).toEqual({ x: 250, y: 100 });
	});

	it("keeps the pill on screen when dragged past an edge", () => {
		const right = clampHudDragPosition({ x: 1396, y: 75 }, size, display);
		expect(right.x + size.width / 2).toBe(1440);
		const left = clampHudDragPosition({ x: -2000, y: 75 }, size, display);
		expect(left.x + size.width / 2).toBe(0);
		const down = clampHudDragPosition({ x: 250, y: 900 }, size, display);
		expect(down.y + size.height).toBe(932);
		const up = clampHudDragPosition({ x: 250, y: -2000 }, size, display);
		expect(up.y + size.height).toBe(25 + 80);
	});
});

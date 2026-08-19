import { describe, expect, it } from "vitest";
import {
	localRectanglesContainScreenPoint,
	normalizePrivateUiRectangles,
	rectanglesContainScreenPoint,
} from "./privateRecordingUi";

describe("private recording UI geometry", () => {
	it("converts actual HUD surface rectangles from window-local to screen coordinates", () => {
		expect(
			localRectanglesContainScreenPoint(
				{ x: 720, y: 880 },
				{ x: 400, y: 300, width: 820, height: 600 },
				[{ x: 300, y: 560, width: 220, height: 40 }],
			),
		).toBe(true);
		expect(
			localRectanglesContainScreenPoint(
				{ x: 500, y: 500 },
				{ x: 400, y: 300, width: 820, height: 600 },
				[{ x: 300, y: 560, width: 220, height: 40 }],
			),
		).toBe(false);
	});

	it("drops malformed rectangles and limits renderer input", () => {
		const rectangles = normalizePrivateUiRectangles([
			{ x: 1, y: 2, width: 30, height: 40 },
			{ x: Number.NaN, y: 0, width: 10, height: 10 },
			{ x: 0, y: 0, width: -1, height: 10 },
			...Array.from({ length: 30 }, (_, index) => ({
				x: index,
				y: index,
				width: 10,
				height: 10,
			})),
		]);

		expect(rectangles).toHaveLength(16);
		expect(rectangles[0]).toEqual({ x: 1, y: 2, width: 30, height: 40 });
	});

	it("matches a point inside any full private window", () => {
		expect(
			rectanglesContainScreenPoint({ x: 1_150, y: 260 }, [
				{ x: 20, y: 20, width: 200, height: 100 },
				{ x: 1_000, y: 100, width: 400, height: 540 },
			]),
		).toBe(true);
	});
});

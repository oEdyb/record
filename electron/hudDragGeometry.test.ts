import { describe, expect, it } from "vitest";
import { clampHudDragPosition, initialHudBounds, resizeHudAroundPill } from "./hudDragGeometry";

const workArea = { x: 0, y: 34, width: 1710, height: 995 };
// Taller than the display: the window reserves menu room above and below the pill.
const size = { width: 940, height: 1400 };
const pill = { width: 424, height: 50 };

function pillRect(position: { x: number; y: number }, pillSize = pill) {
	const centerX = position.x + size.width / 2;
	const centerY = position.y + size.height / 2;
	return {
		left: centerX - pillSize.width / 2,
		right: centerX + pillSize.width / 2,
		top: centerY - pillSize.height / 2,
		bottom: centerY + pillSize.height / 2,
	};
}

describe("clampHudDragPosition", () => {
	it("leaves a drag inside the screen alone", () => {
		expect(clampHudDragPosition({ x: 100, y: -300 }, size, pill, workArea)).toEqual({
			x: 100,
			y: -300,
		});
	});

	it("lets the pill touch every edge of the work area but never leave it", () => {
		const top = pillRect(clampHudDragPosition({ x: 100, y: -5000 }, size, pill, workArea));
		expect(top.top).toBe(34);
		const bottom = pillRect(clampHudDragPosition({ x: 100, y: 5000 }, size, pill, workArea));
		expect(bottom.bottom).toBe(34 + 995);
		const left = pillRect(clampHudDragPosition({ x: -5000, y: 0 }, size, pill, workArea));
		expect(left.left).toBe(0);
		const right = pillRect(clampHudDragPosition({ x: 5000, y: 0 }, size, pill, workArea));
		expect(right.right).toBe(1710);
	});

	it("uses the pill's own size, so the minimized pill reaches further into a corner", () => {
		const small = { width: 88, height: 50 };
		const corner = pillRect(
			clampHudDragPosition({ x: 5000, y: -5000 }, size, small, workArea),
			small,
		);
		expect(corner.right).toBe(1710);
		expect(corner.top).toBe(34);
	});

	it("never returns negative zero, which Electron's setters reject", () => {
		// Centre clamps to 1, so the window edge is 1 - 1.5 = -0.5, which Math.round
		// turns into -0.
		const atOrigin = clampHudDragPosition(
			{ x: -0.4, y: -0.4 },
			{ width: 3, height: 3 },
			{ width: 2, height: 2 },
			{ x: 0, y: 0, width: 100, height: 100 },
		);
		expect(Object.is(atOrigin.x, -0)).toBe(false);
		expect(Object.is(atOrigin.y, -0)).toBe(false);
		expect(atOrigin).toEqual({ x: 0, y: 0 });
	});
});

describe("resizeHudAroundPill", () => {
	it("keeps the pill's centre when the window grows", () => {
		const next = resizeHudAroundPill(
			{ x: 400, y: 0, width: 900, height: 800 },
			size,
			pill,
			workArea,
		);
		expect(next.x + next.width / 2).toBe(850);
		expect(next.y + next.height / 2).toBe(400);
		expect(next.width).toBe(940);
		expect(next.height).toBe(1400);
	});

	it("pulls a pill that grew past the edge back on screen", () => {
		const minimizedAtRight = { x: 1710 - 44 - 470, y: 0, width: 940, height: 1400 };
		const next = resizeHudAroundPill(minimizedAtRight, size, pill, workArea);
		expect(next.x + next.width / 2 + pill.width / 2).toBe(1710);
	});
});

describe("initialHudBounds", () => {
	it("opens with the pill centred near the bottom of the work area", () => {
		const bounds = initialHudBounds(size, pill, workArea);
		expect(bounds.x + bounds.width / 2).toBe(855);
		expect(bounds.y + bounds.height / 2 + pill.height / 2).toBe(34 + 995 - 25);
	});
});

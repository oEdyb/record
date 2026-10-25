import { describe, expect, it } from "vitest";
import {
	clampHudDragPosition,
	HUD_DOCK_PUSH,
	HUD_UNDOCK_PULL,
	hudBoundsAtEdge,
	hudDockPush,
	hudPulledOffEdge,
	initialHudBounds,
	openDisplaySides,
	pillCenterOf,
	resizeHudAroundPill,
} from "./hudDragGeometry";

const workArea = { x: 0, y: 34, width: 1710, height: 995 };
// Taller than the display: the window reserves menu room above and below the pill.
const size = { width: 940, height: 1400 };
const pill = { width: 424, height: 50, offsetX: 0 };

function pillRect(position: { x: number; y: number }, pillSize = pill) {
	const centerX = position.x + size.width / 2 + pillSize.offsetX;
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
		const small = { width: 88, height: 50, offsetX: 0 };
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
			{ width: 2, height: 2, offsetX: 0 },
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

	it("keeps a folded pill's left end where the idle pill's was", () => {
		const window = { x: 400, y: 0, width: 940, height: 1400 };
		const folded = { width: 88, height: 50, offsetX: 44 - 212 };
		const next = resizeHudAroundPill(window, size, folded, workArea);
		expect(next).toEqual(window);
		expect(pillRect(next, folded).left).toBe(pillRect(window).left);
	});

	it("keeps a folded pill pushed into the left edge fully on screen", () => {
		const folded = { width: 88, height: 50, offsetX: 44 - 212 };
		const corner = pillRect(
			clampHudDragPosition({ x: -5000, y: 0 }, size, folded, workArea),
			folded,
		);
		expect(corner.left).toBe(0);
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

describe("hudDockPush", () => {
	const all = new Set(["left", "right", "top"] as const);
	// Where the window goes for the pill's top-left corner to be asked to sit at (left, top).
	const at = (left: number, top = 500) => ({
		x: left + pill.width / 2 - size.width / 2,
		y: top + pill.height / 2 - size.height / 2,
	});

	it("tucks in only once the pill is shoved past the edge, not when it touches it", () => {
		expect(hudDockPush(at(0), size, pill, workArea, all)).toBeNull();
		expect(hudDockPush(at(-HUD_DOCK_PUSH + 1), size, pill, workArea, all)).toBeNull();
		expect(hudDockPush(at(-HUD_DOCK_PUSH), size, pill, workArea, all)).toBe("left");
		expect(hudDockPush(at(1710 - pill.width + HUD_DOCK_PUSH), size, pill, workArea, all)).toBe(
			"right",
		);
		expect(hudDockPush(at(600, 34), size, pill, workArea, all)).toBeNull();
		expect(hudDockPush(at(600, 34 - HUD_DOCK_PUSH), size, pill, workArea, all)).toBe("top");
	});

	it("never tucks into an edge another display continues past", () => {
		const leftOnly = new Set(["left"] as const);
		expect(hudDockPush(at(1710 - pill.width + 200), size, pill, workArea, leftOnly)).toBeNull();
		expect(hudDockPush(at(600, -200), size, pill, workArea, leftOnly)).toBeNull();
	});
});

describe("openDisplaySides", () => {
	const display = { x: 0, y: 0, width: 1710, height: 1107 };

	it("keeps every edge open for a lone display", () => {
		expect([...openDisplaySides(display, [])].sort()).toEqual(["left", "right", "top"]);
	});

	it("closes the edge a neighbouring display sits against", () => {
		const right = { x: 1710, y: -200, width: 2560, height: 1440 };
		expect([...openDisplaySides(display, [right])].sort()).toEqual(["left", "top"]);
		const above = { x: -300, y: -1440, width: 2560, height: 1440 };
		expect([...openDisplaySides(display, [above])].sort()).toEqual(["left", "right"]);
	});

	it("ignores a display beside it that does not overlap", () => {
		const belowRight = { x: 1710, y: 1107, width: 1920, height: 1080 };
		expect([...openDisplaySides(display, [belowRight])].sort()).toEqual(["left", "right", "top"]);
	});
});

describe("hudBoundsAtEdge", () => {
	const tab = { width: 57, height: 50, offsetX: 28.5 - 212, offsetY: 0 };

	it("holds a tab flush against its side edge at the asked-for height", () => {
		const left = hudBoundsAtEdge({ x: 300, y: 500 }, size, tab, workArea, "left");
		expect(pillRect(left, tab).left).toBe(0);
		expect(pillCenterOf(left, size, tab).y).toBe(500);
		const right = hudBoundsAtEdge({ x: 300, y: 500 }, size, tab, workArea, "right");
		expect(pillRect(right, tab).right).toBe(1710);
	});

	it("holds a top tab flush under the top of the work area, above the window centre", () => {
		const topTab = { width: 64, height: 40, offsetX: -180, offsetY: -5 };
		const bounds = hudBoundsAtEdge({ x: 800, y: 900 }, size, topTab, workArea, "top");
		const center = pillCenterOf(bounds, size, topTab);
		expect(center.y - topTab.height / 2).toBe(34);
		expect(center.x).toBe(800);
	});

	it("keeps a side tab inside the work area when dragged past the top", () => {
		const top = hudBoundsAtEdge({ x: 0, y: -900 }, size, tab, workArea, "left");
		expect(pillRect(top, tab).top).toBe(34);
	});
});

describe("hudPulledOffEdge", () => {
	const tab = { width: 57, height: 50 };

	it("untucks only once the pill is pulled well clear of its edge", () => {
		const atLeft = (gap: number) => ({ x: gap + tab.width / 2, y: 500 });
		expect(hudPulledOffEdge(atLeft(0), tab, workArea, "left")).toBe(false);
		expect(hudPulledOffEdge(atLeft(HUD_UNDOCK_PULL - 1), tab, workArea, "left")).toBe(false);
		expect(hudPulledOffEdge(atLeft(HUD_UNDOCK_PULL), tab, workArea, "left")).toBe(true);
		const atRight = { x: 1710 - HUD_UNDOCK_PULL - tab.width / 2, y: 500 };
		expect(hudPulledOffEdge(atRight, tab, workArea, "right")).toBe(true);
		const atTop = { x: 800, y: 34 + HUD_UNDOCK_PULL + tab.height / 2 };
		expect(hudPulledOffEdge(atTop, tab, workArea, "top")).toBe(true);
		expect(hudPulledOffEdge({ x: 800, y: 34 + 25 + 10 }, tab, workArea, "top")).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import {
	computeHudBarMaxHeight,
	computeHudModalMaxHeight,
	computeHudPlacement,
	computeHudPopoverMaxHeight,
	computeHudWindowSize,
	fitHudStackCap,
	HUD_BAR_BOTTOM,
	HUD_EDGE_SLACK,
	HUD_MODAL_MAX_HEIGHT,
	HUD_POPOVER_GAP,
	HUD_POPOVER_MAX_HEIGHT,
	HUD_POPOVER_MIN_HEIGHT,
	HUD_STACK_WIDTH,
} from "./hudGeometry";

const SCREEN = 1080;

function size(barWidth: number, barHeight: number, noticeHeight = 0, availableHeight = SCREEN) {
	return computeHudWindowSize({
		barWidth,
		barHeight,
		noticeHeight,
		// What LaunchWindow reserves: the tallest surface that can float above the
		// bar, regardless of which one is currently open.
		stackMaxHeight: Math.max(
			computeHudPopoverMaxHeight(barHeight, availableHeight),
			computeHudModalMaxHeight(barHeight, availableHeight),
		),
	});
}

describe("computeHudWindowSize", () => {
	it("reserves the popover's full height whether or not one is open", () => {
		// The whole point of reserving: the window is already big enough for a
		// popover before the first one is ever opened, so opening one can't resize
		// (and therefore can't move or flicker) the overlay.
		const { required } = size(520, 48);
		expect(required.height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 48 + HUD_POPOVER_GAP + HUD_POPOVER_MAX_HEIGHT,
		);
	});

	it("reserves enough for the tallest surface, the device-settings panel", () => {
		// The panel is taller than a popover. If the reserve only covered popovers,
		// opening it would grow the window — and because the stack is bottom
		// anchored, that shifts the content and shows up as position judder.
		const { required } = size(520, 48);
		expect(required.height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 48 + HUD_POPOVER_GAP + HUD_MODAL_MAX_HEIGHT,
		);
	});

	it("reserves room for the widest floating panel even when the bar is narrow", () => {
		const { required } = size(48, 520);
		expect(required.width).toBeGreaterThanOrEqual(HUD_STACK_WIDTH + HUD_EDGE_SLACK * 2);
	});

	it("absorbs bar growth without needing a bigger window", () => {
		// Recording adds a timer and three aux buttons to the bar. That must fit in
		// the already-granted window, otherwise every record start is a resize.
		const idle = size(520, 48);
		const recording = size(640, 48);
		expect(recording.required.width).toBeLessThanOrEqual(idle.granted.width);
		expect(recording.required.height).toBeLessThanOrEqual(idle.granted.height);
	});

	it("grows for a notice and shrinks back once it is gone", () => {
		const withNotice = size(520, 48, 140);
		const without = size(520, 48, 0);
		expect(withNotice.required.height).toBeGreaterThan(without.required.height);
	});

	it("mirrors the reserve so the bar sits at the window's centre", () => {
		// The stack can open above or below the pill without moving the window,
		// so the same room is reserved on both sides of the bar.
		const { required } = size(520, 50);
		const sideReserve = (required.height - 50) / 2;
		expect(sideReserve).toBeGreaterThanOrEqual(HUD_POPOVER_GAP + HUD_MODAL_MAX_HEIGHT);
		expect(Number.isInteger(sideReserve)).toBe(true);
	});

	it("may ask for more height than the display, since only the pill stays on screen", () => {
		const shortScreen = 700;
		const { required } = size(424, 50, 0, shortScreen);
		expect(required.height).toBeGreaterThan(shortScreen);
	});
});

describe("computeHudPlacement", () => {
	const area = { areaTop: 34, areaBottom: 1029 };

	it("opens the stack above a pill resting near the bottom", () => {
		const result = computeHudPlacement({
			...area,
			pillTop: 954,
			pillBottom: 1004,
			stackHeight: 560,
		});
		expect(result.placement).toBe("above");
		expect(result.room).toBe(954 - 34 - HUD_POPOVER_GAP - HUD_EDGE_SLACK);
	});

	it("opens the stack below a pill dragged to the top", () => {
		const result = computeHudPlacement({ ...area, pillTop: 34, pillBottom: 84, stackHeight: 560 });
		expect(result.placement).toBe("below");
		expect(result.room).toBe(1029 - 84 - HUD_POPOVER_GAP - HUD_EDGE_SLACK);
	});

	it("stays above when the stack fits there, even with more room below", () => {
		const result = computeHudPlacement({
			...area,
			pillTop: 400,
			pillBottom: 450,
			stackHeight: 300,
		});
		expect(result.placement).toBe("above");
	});

	it("picks the roomier side when the stack fits on neither", () => {
		const result = computeHudPlacement({
			...area,
			pillTop: 500,
			pillBottom: 550,
			stackHeight: 900,
		});
		expect(result.placement).toBe("below");
	});
});

describe("fitHudStackCap", () => {
	it("shrinks a cap to the room on its side, but not below the floor", () => {
		expect(fitHudStackCap(560, 900, 200)).toBe(560);
		expect(fitHudStackCap(560, 400, 200)).toBe(400);
		expect(fitHudStackCap(560, 50, 200)).toBe(200);
	});
});

describe("computeHudPopoverMaxHeight", () => {
	it("caps at the design height when there is plenty of room", () => {
		expect(computeHudPopoverMaxHeight(48, SCREEN)).toBe(HUD_POPOVER_MAX_HEIGHT);
	});

	it("gives way to a tall vertical tray rather than pushing off screen", () => {
		const tall = computeHudPopoverMaxHeight(620, 800);
		expect(tall).toBeLessThan(HUD_POPOVER_MAX_HEIGHT);
		expect(tall).toBeGreaterThanOrEqual(HUD_POPOVER_MIN_HEIGHT);
	});

	it("never returns a height a popover couldn't be usable at", () => {
		expect(computeHudPopoverMaxHeight(2000, 800)).toBe(HUD_POPOVER_MIN_HEIGHT);
	});
});

describe("computeHudBarMaxHeight", () => {
	it("leaves room below the screen height for a popover", () => {
		const max = computeHudBarMaxHeight(SCREEN);
		expect(max).toBeLessThan(SCREEN);
		expect(max + HUD_BAR_BOTTOM + HUD_POPOVER_GAP + HUD_POPOVER_MIN_HEIGHT).toBeLessThanOrEqual(
			SCREEN,
		);
	});
});

import { describe, expect, it } from "vitest";
import { LINUX_HUD_INITIAL_SIZE, linuxHudWindowSize } from "./linuxHudGeometry";

describe("Linux HUD input window", () => {
	it("starts compact instead of covering most of the desktop", () => {
		expect(linuxHudWindowSize([{ x: 24, y: 38, width: 424, height: 50 }])).toEqual(
			LINUX_HUD_INITIAL_SIZE,
		);
	});

	it("grows to fit open panels and select portals, then shrinks when they close", () => {
		const pill = { x: 24, y: 38, width: 424, height: 50 };
		const panel = { x: 24, y: 96, width: 652, height: 400 };
		const select = { x: 350, y: 220, width: 360, height: 320 };
		expect(linuxHudWindowSize([pill, panel, select])).toEqual({ width: 734, height: 564 });
		expect(linuxHudWindowSize([pill])).toEqual(LINUX_HUD_INITIAL_SIZE);
	});

	it("keeps the grip's allocation stable while the pill folds", () => {
		expect(linuxHudWindowSize([{ x: 24, y: 38, width: 100, height: 50 }])).toEqual(
			LINUX_HUD_INITIAL_SIZE,
		);
	});

	it("rounds fractional content outwards without resizing an empty renderer", () => {
		expect(linuxHudWindowSize([{ x: 24.2, y: 38.4, width: 652.3, height: 50.4 }])).toEqual({
			width: 701,
			height: 113,
		});
		expect(linuxHudWindowSize([])).toBeNull();
	});
});

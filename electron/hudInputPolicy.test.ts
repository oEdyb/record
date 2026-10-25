import { describe, expect, it } from "vitest";
import {
	hudPointerProbe,
	shouldShowHudInactive,
	shouldStartHudClickThrough,
} from "./hudInputPolicy";

describe("HUD input startup policy", () => {
	it("starts click-through on macOS so the transparent backing window cannot swallow clicks", () => {
		expect(shouldStartHudClickThrough("darwin")).toBe(true);
	});

	it.each([
		"win32",
		"linux",
	] as const)("keeps the renderer-driven startup path on %s", (platform) => {
		expect(shouldStartHudClickThrough(platform)).toBe(false);
	});

	it("shows the macOS HUD without activating Klippt", () => {
		expect(shouldShowHudInactive("darwin")).toBe(true);
	});

	it.each(["win32", "linux"] as const)("keeps the normal first-show behavior on %s", (platform) => {
		expect(shouldShowHudInactive(platform)).toBe(false);
	});

	it("gives the cursor's place inside the HUD content, and null once it has left", () => {
		const content = { x: 100, y: 200, width: 900, height: 600 };
		expect(hudPointerProbe({ x: 150, y: 260 }, content)).toEqual({ x: 50, y: 60 });
		expect(hudPointerProbe({ x: 99, y: 260 }, content)).toBeNull();
		expect(hudPointerProbe({ x: 1000, y: 260 }, content)).toBeNull();
		expect(hudPointerProbe({ x: 150, y: 800 }, content)).toBeNull();
	});
});

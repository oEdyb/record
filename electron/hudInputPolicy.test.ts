import { describe, expect, it } from "vitest";
import { shouldShowHudInactive, shouldStartHudClickThrough } from "./hudInputPolicy";

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
});

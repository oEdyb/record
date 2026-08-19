import { describe, expect, it } from "vitest";
import { shouldStartHudClickThrough } from "./hudInputPolicy";

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
});

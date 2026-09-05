import { describe, expect, it } from "vitest";
import { checkDesignPolicy, hasNativeSelect, inspectStylePolicy } from "./check-design-policy.mjs";

describe("shared design policy", () => {
	it("checks production controls once", () => {
		expect(checkDesignPolicy()).toEqual([]);
	});
	it("ignores comments without accepting a commented-out semantic token", () => {
		expect(
			inspectStylePolicy("/* green; color: var(--editor-accent) */ .x { color: white }", [
				"--editor-accent",
			]),
		).toEqual(["Missing semantic token: --editor-accent"]);
	});
	it("rejects theme literals in declarations even beside a semantic token", () => {
		expect(
			inspectStylePolicy(".x { color: var(--editor-accent); color: #22c55e }", ["--editor-accent"]),
		).toEqual(["Green theme value: #22c55e"]);
	});
	it("recognizes raw select elements without matching comments or strings", () => {
		expect(hasNativeSelect('const example = "<select>"; // <select>')).toBe(false);
		expect(hasNativeSelect("const field = <select aria-label='Size' />")).toBe(true);
		expect(hasNativeSelect("const field = <select><option>Size</option></select>")).toBe(true);
		expect(hasNativeSelect("const field = <AppSelect />")).toBe(false);
	});
});

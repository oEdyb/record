import { describe, expect, it } from "vitest";
import {
	hasCanonicalProjectExtension,
	isSupportedProjectFile,
	withCanonicalProjectExtension,
} from "./projectFileFormat";

describe("project file format", () => {
	it("uses .klippt as the canonical project extension", () => {
		expect(hasCanonicalProjectExtension("Demo.klippt")).toBe(true);
		expect(withCanonicalProjectExtension("Demo")).toBe("Demo.klippt");
	});

	it("accepts legacy project extensions without treating them as canonical", () => {
		expect(isSupportedProjectFile("Demo.openscreen")).toBe(true);
		expect(isSupportedProjectFile("Demo.AXCUT")).toBe(true);
		expect(hasCanonicalProjectExtension("Demo.openscreen")).toBe(false);
	});

	it("converts a legacy path to a sibling .klippt path", () => {
		expect(withCanonicalProjectExtension("/Projects/Demo.openscreen")).toBe(
			"/Projects/Demo.klippt",
		);
		expect(withCanonicalProjectExtension("C:\\Projects\\Demo.axcut")).toBe(
			"C:\\Projects\\Demo.klippt",
		);
	});

	it("rejects unrelated files", () => {
		expect(isSupportedProjectFile("Demo.json")).toBe(false);
		expect(isSupportedProjectFile("Demo.mp4")).toBe(false);
	});
});

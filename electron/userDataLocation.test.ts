import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseUserDataDirectory } from "./userDataLocation";

const appData = "/Users/test/Library/Application Support";

describe("user data location", () => {
	it("keeps using an existing OpenScreen-era folder", () => {
		const legacy = path.join(appData, "openscreen");
		expect(chooseUserDataDirectory({ appData, exists: (p) => p === legacy })).toBe(legacy);
	});

	it("starts a Mac that never ran the old build in the Klippt folder", () => {
		expect(chooseUserDataDirectory({ appData, exists: () => false })).toBe(
			path.join(appData, "Klippt"),
		);
	});

	it("honours an explicit test or CLI data directory first", () => {
		expect(
			chooseUserDataDirectory({ appData, override: " /tmp/klippt-test ", exists: () => true }),
		).toBe("/tmp/klippt-test");
		expect(chooseUserDataDirectory({ appData, override: "  ", exists: () => false })).toBe(
			path.join(appData, "Klippt"),
		);
	});
});

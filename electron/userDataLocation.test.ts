import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseUserDataDirectory, markUserDataDirectory } from "./userDataLocation";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function appData(...folders: string[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-app-data-"));
	roots.push(root);
	for (const folder of folders) fs.mkdirSync(path.join(root, folder), { recursive: true });
	return root;
}

describe("user data location", () => {
	it("keeps using an existing Klippt-era openscreen folder", () => {
		const root = appData("openscreen", "Klippt/Archived Apps.noindex");
		expect(chooseUserDataDirectory({ appData: root })).toBe(path.join(root, "openscreen"));
	});

	it("starts a Mac that never ran the old build in a marked Klippt folder", () => {
		const root = appData();
		const chosen = chooseUserDataDirectory({ appData: root });
		expect(chosen).toBe(path.join(root, "Klippt"));
		markUserDataDirectory(chosen, root);
		expect(fs.existsSync(path.join(chosen, ".klippt-user-data"))).toBe(true);
	});

	it("does not switch a fresh install to a folder another app creates later", () => {
		const root = appData();
		markUserDataDirectory(chooseUserDataDirectory({ appData: root }), root);
		fs.mkdirSync(path.join(root, "openscreen"));
		expect(chooseUserDataDirectory({ appData: root })).toBe(path.join(root, "Klippt"));
	});

	it("ignores upstream OpenScreen's differently cased folder", () => {
		const root = "/Users/test/Library/Application Support";
		expect(
			chooseUserDataDirectory({
				appData: root,
				listAppData: () => ["Openscreen"],
				exists: () => false,
			}),
		).toBe(path.join(root, "Klippt"));
	});

	it("never marks the legacy folder", () => {
		const root = appData("openscreen");
		markUserDataDirectory(path.join(root, "openscreen"), root);
		expect(fs.existsSync(path.join(root, "openscreen", ".klippt-user-data"))).toBe(false);
	});

	it("honours an explicit test or CLI data directory first", () => {
		const root = appData("openscreen");
		expect(chooseUserDataDirectory({ appData: root, override: " /tmp/klippt-test " })).toBe(
			"/tmp/klippt-test",
		);
		expect(chooseUserDataDirectory({ appData: root, override: "  " })).toBe(
			path.join(root, "openscreen"),
		);
	});
});

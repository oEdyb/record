import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeUnmanagedProjectFile } from "./unmanagedProjectSave";

describe("legacy Save destinations", () => {
	let root: string;
	let managed: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-save-"));
		managed = path.join(root, "projects");
		await fs.mkdir(managed);
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	it("creates and replaces ordinary standalone projects", async () => {
		const destination = path.join(root, "exports", "ordinary.klippt");
		await writeUnmanagedProjectFile(destination, { version: 2, title: "Original" }, managed);
		await writeUnmanagedProjectFile(destination, { version: 2, title: "Edited" }, managed);
		expect(JSON.parse(await fs.readFile(destination, "utf8"))).toMatchObject({ title: "Edited" });
	});
	it("refuses every managed target even before transaction adoption", async () => {
		const destination = path.join(managed, "project.klippt");
		await expect(writeUnmanagedProjectFile(destination, {}, managed)).rejects.toThrow(
			"Managed projects",
		);
		expect(await fs.readdir(managed)).toEqual([]);
	});
	it("preserves adopted project bytes and receipts through an outside final symlink", async () => {
		const target = path.join(managed, "project.klippt");
		const raw = JSON.stringify({ schemaVersion: 9, _klipptTransactions: { receipt: "kept" } });
		await fs.writeFile(target, raw);
		const link = path.join(root, "alias.klippt");
		await fs.symlink(target, link);
		await expect(writeUnmanagedProjectFile(link, {}, managed)).rejects.toThrow("Managed projects");
		expect(await fs.readFile(target, "utf8")).toBe(raw);
	});
	it("rejects a managed parent symlink for a previously absent file", async () => {
		const link = path.join(root, "alias");
		await fs.symlink(managed, link);
		await expect(
			writeUnmanagedProjectFile(path.join(link, "new.klippt"), {}, managed),
		).rejects.toThrow("Managed projects");
	});
	it("refuses an adopted standalone file rather than stripping unknown receipt metadata", async () => {
		const destination = path.join(root, "adopted.klippt");
		const raw = JSON.stringify({ _klipptTransactions: { version: 1 } });
		await fs.writeFile(destination, raw);
		await expect(writeUnmanagedProjectFile(destination, { version: 2 }, managed)).rejects.toThrow(
			"overwrite refused",
		);
		expect(await fs.readFile(destination, "utf8")).toBe(raw);
	});
	it("refuses copying transaction identity but preserves a normal standalone symlink save", async () => {
		await expect(
			writeUnmanagedProjectFile(
				path.join(root, "copy.klippt"),
				{ _klipptTransactions: {} },
				managed,
			),
		).rejects.toThrow("mutation identity");
		const target = path.join(root, "target.klippt");
		await fs.writeFile(target, "{}");
		const link = path.join(root, "alias.klippt");
		await fs.symlink(target, link);
		await writeUnmanagedProjectFile(link, { title: "Updated" }, managed);
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toMatchObject({ title: "Updated" });
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});
});

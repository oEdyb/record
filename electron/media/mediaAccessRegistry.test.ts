import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MediaAccessRegistry } from "./mediaAccessRegistry";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-media-grants-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});
it("does not authorize a document reference, but restores an actual selected file after restart", async () => {
	const file = path.join(root, "private.wav");
	await fs.writeFile(file, "media");
	const record = path.join(root, "grants.json");
	const registry = new MediaAccessRegistry(record);
	const canonical = await fs.realpath(file);
	expect(registry.hasCanonicalPath(canonical)).toBe(false);
	await registry.grantSelectedFile(file);
	expect(new MediaAccessRegistry(record).hasCanonicalPath(canonical)).toBe(true);
	const other = path.join(root, "other.wav");
	await fs.writeFile(other, "other");
	expect(new MediaAccessRegistry(record).hasCanonicalPath(await fs.realpath(other))).toBe(false);
});
it("rejects project-directory symlink escapes and does not transfer a grant to a swapped target", async () => {
	const project = path.join(root, "project");
	await fs.mkdir(project);
	const outside = path.join(root, "private.wav");
	await fs.writeFile(outside, "private");
	const inside = path.join(project, "selected.wav");
	await fs.writeFile(inside, "selected");
	const link = path.join(project, "linked.wav");
	await fs.symlink(outside, link);
	const registry = new MediaAccessRegistry(path.join(root, "grants.json"));
	await expect(registry.grantSelectedFile(link, [project])).rejects.toThrow("escapes");
	await fs.unlink(link);
	await fs.symlink(inside, link);
	await registry.grantSelectedFile(link, [project]);
	await fs.unlink(link);
	await fs.symlink(outside, link);
	expect(registry.hasCanonicalPath(await fs.realpath(link))).toBe(false);
});
it("serializes simultaneous grants without losing either durable entry", async () => {
	const files = [path.join(root, "a.wav"), path.join(root, "b.wav")];
	await Promise.all(files.map((file) => fs.writeFile(file, "audio")));
	const record = path.join(root, "grants.json");
	const registry = new MediaAccessRegistry(record);
	await Promise.all(files.map((file) => registry.grantSelectedFile(file)));
	const reopened = new MediaAccessRegistry(record);
	for (const file of files) expect(reopened.hasCanonicalPath(await fs.realpath(file))).toBe(true);
});

it("refuses registry overflow without dropping previous grants", async () => {
	const record = path.join(root, "grants.json");
	const previous = JSON.stringify({
		version: 1,
		paths: Array.from({ length: 4096 }, (_, index) => `/selected/${index}.wav`),
	});
	await fs.writeFile(record, previous);
	const registry = new MediaAccessRegistry(record);
	const extra = path.join(root, "extra.wav");
	await fs.writeFile(extra, "extra");
	await expect(registry.grantSelectedFile(extra)).rejects.toThrow();
	expect(await fs.readFile(record, "utf8")).toBe(previous);
	expect(registry.hasCanonicalPath("/selected/0.wav")).toBe(true);
});

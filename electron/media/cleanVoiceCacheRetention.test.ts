import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneCleanVoiceCacheAtStartup } from "./cleanVoiceCacheRetention";

let root: string;
const now = Date.UTC(2026, 8, 5);
const day = 24 * 60 * 60 * 1000;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-clean-retention-"));
	await fs.mkdir(path.join(root, "entries"));
	await fs.mkdir(path.join(root, "links"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function entry(key: string, ageDays: number) {
	const directory = path.join(root, "entries", key);
	await fs.mkdir(directory);
	const manifest = {
		version: 1,
		cacheKey: key,
		createdAt: new Date(now - ageDays * day).toISOString(),
		output: { file: "clean-microphone.wav", sha256: "a".repeat(64) },
		preview: { file: "preview-audio.m4a", sha256: "b".repeat(64) },
	};
	await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
	await fs.writeFile(path.join(directory, "clean-microphone.wav"), "derived");
	await fs.writeFile(path.join(directory, "preview-audio.m4a"), "preview");
	for (const name of await fs.readdir(directory))
		await fs.utimes(
			path.join(directory, name),
			(now - ageDays * day) / 1000,
			(now - ageDays * day) / 1000,
		);
	await fs.utimes(directory, (now - ageDays * day) / 1000, (now - ageDays * day) / 1000);
	return directory;
}

describe("cold-start Clean Voice retention", () => {
	it("removes old completed derivatives and their links but keeps recent work and originals", async () => {
		const oldKey = "1".repeat(64),
			recentKey = "2".repeat(64),
			request = "3".repeat(64);
		const old = await entry(oldKey, 31),
			recent = await entry(recentKey, 1);
		const link = path.join(root, "links", `${request}.json`);
		await fs.writeFile(link, JSON.stringify({ version: 1, requestKey: request, cacheKey: oldKey }));
		await fs.writeFile(path.join(root, "original.mp4"), "original");
		const summary = await pruneCleanVoiceCacheAtStartup(root, { now });
		expect(summary.completedEntries).toBe(2);
		expect(summary.removedEntries).toBe(1);
		await expect(fs.stat(old)).rejects.toThrow();
		await expect(fs.stat(link)).rejects.toThrow();
		expect((await fs.stat(recent)).isDirectory()).toBe(true);
		expect(await fs.readFile(path.join(root, "original.mp4"), "utf8")).toBe("original");
	});

	it("uses the byte budget to evict oldest completed work first", async () => {
		const old = await entry("4".repeat(64), 3),
			recent = await entry("5".repeat(64), 1);
		const recentFiles = await fs.readdir(recent);
		const sizes = await Promise.all(
			recentFiles.map(async (file) => (await fs.stat(path.join(recent, file))).size),
		);
		const summary = await pruneCleanVoiceCacheAtStartup(root, {
			now,
			maxBytes: sizes.reduce((a, b) => a + b, 0),
		});
		expect(summary.removedEntries).toBe(1);
		await expect(fs.stat(old)).rejects.toThrow();
		expect((await fs.stat(recent)).isDirectory()).toBe(true);
	});

	it("skips symlinks, unknown files, incomplete entries and staging", async () => {
		const outside = path.join(root, "originals");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "source.wav"), "raw");
		await fs.symlink(outside, path.join(root, "entries", "6".repeat(64)), "dir");
		const unknown = await entry("7".repeat(64), 40);
		await fs.writeFile(path.join(unknown, "raw-source.wav"), "raw");
		const linked = await entry("8".repeat(64), 40);
		await fs.unlink(path.join(linked, "clean-microphone.wav"));
		await fs.symlink(path.join(outside, "source.wav"), path.join(linked, "clean-microphone.wav"));
		await fs.mkdir(path.join(root, "staging"));
		await fs.writeFile(path.join(root, "staging", "processing.wav"), "active");
		const summary = await pruneCleanVoiceCacheAtStartup(root, { now, maxBytes: 0 });
		expect(summary.removedEntries).toBe(0);
		expect(summary.skippedEntries).toBe(3);
		expect(await fs.readFile(path.join(outside, "source.wav"), "utf8")).toBe("raw");
		expect(await fs.readFile(path.join(root, "staging", "processing.wav"), "utf8")).toBe("active");
	});

	it("does not follow a symlinked cache root", async () => {
		const existing = await entry("9".repeat(64), 50);
		const alias = path.join(root, "alias");
		await fs.symlink(root, alias, "dir");
		expect((await pruneCleanVoiceCacheAtStartup(alias, { now, maxBytes: 0 })).removedEntries).toBe(
			0,
		);
		expect((await fs.stat(existing)).isDirectory()).toBe(true);
	});
});

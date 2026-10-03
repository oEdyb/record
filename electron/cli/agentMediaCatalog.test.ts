// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogAgentMedia } from "./agentMediaCatalog";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "klippt-media-catalog-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("read-only media folder catalog", () => {
	it("classifies candidates by extension without pretending to probe invalid media", async () => {
		await Promise.all(
			["Z video.MP4", "image.PNG", "voice.aiff", "notes.txt"].map((name) =>
				writeFile(join(root, name), "not valid media"),
			),
		);
		const result = await catalogAgentMedia(root);
		expect(result.items.map((item) => [item.relative_path, item.kind])).toEqual([
			["Z video.MP4", "video"],
			["image.PNG", "image"],
			["voice.aiff", "audio"],
		]);
		expect(result.items.every((item) => item.metadata === "not_probed")).toBe(true);
		expect(result.items[0].size_bytes).toBe(15);
		expect(result).toMatchObject({
			complete: true,
			total: null,
			examined_entries: 4,
			matched_in_scan: 3,
		});
		const again = await catalogAgentMedia(root);
		expect(again.items).toEqual(result.items);
	});
	it("never follows directory or file symlinks, including a root link", async () => {
		await mkdir(join(root, "actual"));
		await writeFile(join(root, "actual", "clip.mp4"), "x");
		await symlink(join(root, "actual"), join(root, "alias"), "dir");
		await symlink(join(root, "actual", "clip.mp4"), join(root, "linked.mp4"));
		const result = await catalogAgentMedia(root, { depth: 1 });
		expect(result.items.map((item) => item.relative_path)).toEqual(["actual/clip.mp4"]);
		await expect(catalogAgentMedia(join(root, "alias"))).rejects.toThrow("INVALID_DIRECTORY");
	});
	it("bounds depth and reports unvisited deeper directories", async () => {
		await mkdir(join(root, "nested", "deep"), { recursive: true });
		await writeFile(join(root, "nested", "clip.mp4"), "x");
		await writeFile(join(root, "nested", "deep", "clip.mp4"), "x");
		expect(await catalogAgentMedia(root)).toMatchObject({
			items: [],
			unvisited_deeper_directories: 1,
		});
		const result = await catalogAgentMedia(root, { depth: 1 });
		expect(result.items.map((item) => item.relative_path)).toEqual(["nested/clip.mp4"]);
		expect(result.unvisited_deeper_directories).toBe(1);
	});
	it("caps examined unsupported entries and exposes an incomplete scan without a fake total", async () => {
		await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(join(root, `${i}.txt`), "x")));
		const result = await catalogAgentMedia(root, { maxExamined: 3 });
		expect(result).toMatchObject({
			complete: false,
			truncated: true,
			examined_entries: 3,
			total: null,
			items: [],
		});
	});
	it("sorts the scanned result before limiting and distinguishes output truncation", async () => {
		await Promise.all(["z.mp4", "a.mp4", "b.mp4"].map((name) => writeFile(join(root, name), "x")));
		const result = await catalogAgentMedia(root, { limit: 1 });
		expect(result.items[0].relative_path).toBe("a.mp4");
		expect(result).toMatchObject({
			complete: false,
			truncated: true,
			matched_in_scan: 3,
			examined_entries: 3,
		});
	});
	it("rejects unbounded or invalid scan options and file roots", async () => {
		await expect(catalogAgentMedia(root, { maxExamined: Infinity })).rejects.toThrow(
			"INVALID_ARGUMENT",
		);
		await expect(catalogAgentMedia(root, { depth: 6 })).rejects.toThrow("INVALID_ARGUMENT");
		await expect(catalogAgentMedia(root, { limit: 0 })).rejects.toThrow("INVALID_ARGUMENT");
		await writeFile(join(root, "file.mp4"), "x");
		await expect(catalogAgentMedia(join(root, "file.mp4"))).rejects.toThrow("INVALID_DIRECTORY");
	});
});

// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assetThumbnails, thumbnailCacheKey } from "./agentAssets";

describe("asset thumbnails", () => {
	it("keys cache by absolute file, mtime and size", () => {
		expect(thumbnailCacheKey("/one.mp4", 10, 20)).toBe(thumbnailCacheKey("/one.mp4", 10, 20));
		for (const args of [
			["/two.mp4", 10, 20],
			["/one.mp4", 11, 20],
			["/one.mp4", 10, 21],
		] as const)
			expect(thumbnailCacheKey(args[0], args[1], args[2])).not.toBe(
				thumbnailCacheKey("/one.mp4", 10, 20),
			);
	});
	it("extracts first/middle once and reuses a completed cache", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-thumb-test-"));
		try {
			const file = path.join(dir, "asset.mp4");
			await fs.writeFile(file, "source");
			const run = vi.fn(async (_exe: string, args: string[]) => {
				if (args.length === 3)
					return { stdout: "", stderr: "Duration: 00:00:10.00\nVideo: h264, yuv420p, 1920x1080" };
				await fs.writeFile(args.at(-1)!, "jpeg");
				return { stdout: "", stderr: "" };
			});
			const first = await assetThumbnails(file, path.join(dir, "cache"), "ffmpeg", undefined, run);
			expect(first).toMatchObject({ durationSec: 10, width: 1920, height: 1080, cached: false });
			expect(run.mock.calls[2][1]).toContain("5");
			expect(
				(await assetThumbnails(file, path.join(dir, "cache"), "ffmpeg", undefined, run)).cached,
			).toBe(true);
			expect(run).toHaveBeenCalledTimes(3);
			await fs.unlink(first.middle);
			expect(
				(await assetThumbnails(file, path.join(dir, "cache"), "ffmpeg", undefined, run)).cached,
			).toBe(false);
			await expect(fs.access(first.middle)).resolves.toBeUndefined();
			expect(run).toHaveBeenCalledTimes(6);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

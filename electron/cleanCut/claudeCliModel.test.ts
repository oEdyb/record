import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeCliModel, replyCachePath } from "./claudeCliModel";

describe("claudeCliModel", () => {
	it("answers from the cache and never starts Claude in cache-only mode", async () => {
		const cacheDir = await mkdtemp(path.join(tmpdir(), "clean-cut-replies-"));
		await writeFile(replyCachePath(cacheDir, "hit", "sonnet", "units"), "cached");
		const spawnProcess = vi.fn();
		const model = claudeCliModel({
			binary: "/nonexistent/claude",
			cacheDir,
			cacheOnly: true,
			spawnProcess: spawnProcess as never,
		});
		await expect(model.ask("hit", "units")).resolves.toBe("cached");
		await expect(model.ask("miss", "units")).rejects.toThrow("No cached units reply.");
		expect(spawnProcess).not.toHaveBeenCalled();
	});
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { pruneCleanVoiceCacheAtStartup } from "./cleanVoiceCacheRetention";
import { CleanVoiceService } from "./cleanVoiceService";

vi.mock("./cleanVoiceCacheRetention", () => ({ pruneCleanVoiceCacheAtStartup: vi.fn() }));

it("finishes startup pruning before processing can publish a path and does not prune again", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-clean-startup-"));
	const source = path.join(root, "original.mp4");
	await fs.writeFile(source, "raw");
	let releasePrune: (() => void) | undefined;
	let enteredPrune: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => {
		enteredPrune = resolve;
	});
	vi.mocked(pruneCleanVoiceCacheAtStartup).mockImplementation(async () => {
		enteredPrune?.();
		await new Promise<void>((resolve) => {
			releasePrune = resolve;
		});
		return {
			completedEntries: 0,
			completedBytes: 0,
			removedEntries: 0,
			removedBytes: 0,
			skippedEntries: 0,
		};
	});
	const identity = vi.fn(async () => {
		throw new Error("test model unavailable");
	});
	let finished: (() => void) | undefined;
	const done = new Promise<void>((resolve) => {
		finished = resolve;
	});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const service = new CleanVoiceService({
		cacheRoot: root,
		pruneCompletedEntriesOnStartup: true,
		processor: {
			identity,
			process: vi.fn(async () => {
				throw new Error("must not process");
			}),
		},
		onStatus: (status) => {
			if (status.phase === "failed") finished?.();
		},
	});
	try {
		const document = createEmptyDocument({ projectId: "p", title: "p" });
		document.assets.push({
			id: "a",
			kind: "video",
			label: "a",
			originalPath: source,
			cameraTrack: null,
			cleanVoice: {
				version: 1,
				mode: "natural",
				engine: "deepfilternet3",
				attenuationLimitDb: 6,
				postFilter: false,
			},
		});
		await entered;
		await service.syncDocument(document);
		expect(identity).not.toHaveBeenCalled();
		expect(service.getResolvedStem("p", "a")).toBeNull();
		releasePrune?.();
		await done;
		await service.syncDocument(document);
		expect(pruneCleanVoiceCacheAtStartup).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(source, "utf8")).toBe("raw");
	} finally {
		service.dispose();
		warn.mockRestore();
		await fs.rm(root, { recursive: true, force: true });
	}
});

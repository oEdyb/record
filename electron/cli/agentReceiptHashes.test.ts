// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import { buildReceiptHashes, hashImportedMedia, sha256File } from "./agentReceiptHashes";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function tempDirectory() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-receipt-hashes-"));
	cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

describe("sha256File", () => {
	it("hashes file bytes with a streaming read", async () => {
		const directory = await tempDirectory();
		const file = path.join(directory, "media.bin");
		const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
		await fs.writeFile(file, bytes);
		expect(await sha256File(file)).toBe(createHash("sha256").update(bytes).digest("hex"));
	});

	it("rejects a directory instead of hashing it", async () => {
		const directory = await tempDirectory();
		await expect(sha256File(directory)).rejects.toThrow("regular file");
	});
});

describe("hashImportedMedia", () => {
	it("hashes only assets the transaction added, video and audio", async () => {
		const directory = await tempDirectory();
		const video = path.join(directory, "new.mp4");
		const audio = path.join(directory, "music.wav");
		await fs.writeFile(video, "video-bytes");
		await fs.writeFile(audio, "audio-bytes");
		const before = editFixture();
		const after = structuredClone(before);
		after.assets.push({
			id: "asset2",
			kind: "video",
			label: "New take",
			originalPath: video,
			durationSec: 5,
			cameraTrack: null,
		});
		after.audioAssets = [
			{ id: "aud", label: "Music", originalPath: audio, durationSec: 3 },
			{
				id: "gone",
				label: "Missing",
				originalPath: path.join(directory, "missing.wav"),
				durationSec: 3,
			},
		];
		const hashes = await hashImportedMedia(before, after);
		expect(hashes).toEqual([
			{
				asset_id: "asset2",
				kind: "video",
				path: video,
				sha256: createHash("sha256").update("video-bytes").digest("hex"),
				status: "hashed",
			},
			{
				asset_id: "aud",
				kind: "audio",
				path: audio,
				sha256: createHash("sha256").update("audio-bytes").digest("hex"),
				status: "hashed",
			},
			{
				asset_id: "gone",
				kind: "audio",
				path: path.join(directory, "missing.wav"),
				sha256: null,
				status: "unreadable",
			},
		]);
	});

	it("hashes nothing when the transaction added no assets", async () => {
		const document = editFixture();
		expect(await hashImportedMedia(document, structuredClone(document))).toEqual([]);
	});
});

describe("buildReceiptHashes", () => {
	it("carries the caller's project file hashes alongside imported media", async () => {
		const document = editFixture();
		const hashes = await buildReceiptHashes(document, structuredClone(document), {
			sha256Before: "a".repeat(64),
			sha256After: "b".repeat(64),
		});
		expect(hashes).toEqual({
			sha256_before: "a".repeat(64),
			sha256_after: "b".repeat(64),
			imported_media: [],
		});
	});
});

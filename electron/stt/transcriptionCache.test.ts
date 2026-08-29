import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	TranscriptCache,
	type TranscriptCacheIdentity,
	transcriptCacheKey,
} from "./transcriptionCache";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "klippt-stt-cache-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function identity(patch: Partial<TranscriptCacheIdentity> = {}): TranscriptCacheIdentity {
	return {
		version: 1,
		sourceContentSha256: "a".repeat(64),
		sourceDurationSec: 1,
		sourceRole: "you",
		backend: "parakeet-coreml",
		model: {
			id: "parakeet-v3",
			revision: "revision",
			artifactSha256: ["b".repeat(64)],
		},
		requestedLanguage: "auto",
		extractionVersion: 1,
		chunkingVersion: 1,
		seamVersion: 1,
		alignmentVersion: 1,
		vocabularySha256: "none",
		...patch,
	};
}

const result = {
	segments: [{ text: "hello", startSec: 0, endSec: 0.5, sourceRole: "you" as const }],
	wordSegments: [
		{
			word: "hello",
			startSec: 0,
			endSec: 0.5,
			confidence: 0.9,
			sourceRole: "you" as const,
		},
	],
	detectedLanguage: "en",
	backend: "parakeet-coreml" as const,
	processedSec: 1,
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("TranscriptCache", () => {
	it("publishes a complete entry atomically and reads it back", async () => {
		const directory = await temporaryDirectory();
		const cache = new TranscriptCache(directory);
		await cache.write(identity(), result);

		expect(await cache.read(identity())).toEqual(result);
		expect((await readdir(directory)).every((name) => !name.endsWith(".partial"))).toBe(true);
	});

	it("ignores partial and malformed entries", async () => {
		const directory = await temporaryDirectory();
		await mkdir(directory, { recursive: true });
		const key = transcriptCacheKey(identity());
		await writeFile(path.join(directory, `${key}.json.partial`), JSON.stringify({ result }));
		await writeFile(path.join(directory, `${key}.json`), "not-json");

		expect(await new TranscriptCache(directory).read(identity())).toBeNull();
	});

	it("invalidates changes to the model or pipeline identity", async () => {
		const directory = await temporaryDirectory();
		const cache = new TranscriptCache(directory);
		await cache.write(identity(), result);

		expect(await cache.read(identity({ seamVersion: 2 }))).toBeNull();
		expect(await cache.read(identity({ alignmentVersion: 2 }))).toBeNull();
		expect(
			await cache.read(
				identity({ model: { ...identity().model, revision: "different-revision" } }),
			),
		).toBeNull();
	});

	it("ignores a valid-looking entry stored under the wrong identity", async () => {
		const directory = await temporaryDirectory();
		await mkdir(directory, { recursive: true });
		const expected = identity({ seamVersion: 2 });
		await writeFile(
			path.join(directory, `${transcriptCacheKey(expected)}.json`),
			JSON.stringify({ version: 1, identity: identity(), result }),
		);

		expect(await new TranscriptCache(directory).read(expected)).toBeNull();
	});

	it("rejects a valid-shaped transcript that did not process the complete source", async () => {
		const directory = await temporaryDirectory();
		const cache = new TranscriptCache(directory);
		const longIdentity = identity({ sourceDurationSec: 90 });

		await expect(cache.write(longIdentity, result)).rejects.toThrow("invalid source transcript");
	});

	it("rejects speech phrases without matching native word timing", async () => {
		const directory = await temporaryDirectory();
		const cache = new TranscriptCache(directory);
		const uncovered = {
			...result,
			segments: [
				...result.segments,
				{ text: "missing", startSec: 0.6, endSec: 0.9, sourceRole: "you" as const },
			],
		};

		await expect(cache.write(identity(), uncovered)).rejects.toThrow("invalid source transcript");
	});
});

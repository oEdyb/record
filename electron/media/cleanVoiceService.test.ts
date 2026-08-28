import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type CleanVoiceRecipe,
	createEmptyDocument,
} from "../../src/lib/ai-edition/schema";
import { type CleanVoiceJobStatus, CleanVoiceService } from "./cleanVoiceService";
import {
	CleanVoiceCancelledError,
	type CleanVoiceEngineIdentity,
	type CleanVoiceProcessor,
	sha256File,
} from "./cleanVoiceWorker";

const engine: CleanVoiceEngineIdentity = {
	id: "test-engine",
	commit: "test-commit",
	modelSha256: "a".repeat(64),
	helperSha256: "b".repeat(64),
};

const naturalRecipe = {
	version: 1,
	mode: "natural",
	engine: "deepfilternet3",
	attenuationLimitDb: 6,
	postFilter: false,
} satisfies CleanVoiceRecipe;

function waveBuffer(samples: number): Buffer {
	const dataBytes = samples * Float32Array.BYTES_PER_ELEMENT;
	const buffer = Buffer.alloc(44 + dataBytes);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataBytes, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(3, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(48_000, 24);
	buffer.writeUInt32LE(48_000 * Float32Array.BYTES_PER_ELEMENT, 28);
	buffer.writeUInt16LE(Float32Array.BYTES_PER_ELEMENT, 32);
	buffer.writeUInt16LE(32, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataBytes, 40);
	for (let index = 0; index < samples; index += 1) {
		buffer.writeFloatLE(Math.sin(index / 8) * 0.05, 44 + index * 4);
	}
	return buffer;
}

function documentWithRecipe(sourcePath: string, recipe?: CleanVoiceRecipe): AxcutDocument {
	const document = createEmptyDocument({ projectId: "project-1", title: "Project" });
	document.assets.push({
		id: "asset-1",
		kind: "video",
		label: "Recording",
		originalPath: sourcePath,
		cameraTrack: null,
		...(recipe ? { cleanVoice: recipe } : {}),
	});
	return document;
}

async function waitFor(
	statuses: CleanVoiceJobStatus[],
	phase: CleanVoiceJobStatus["phase"],
): Promise<CleanVoiceJobStatus> {
	const deadline = Date.now() + 3_000;
	for (;;) {
		for (let index = statuses.length - 1; index >= 0; index -= 1) {
			if (statuses[index].phase === phase) return statuses[index];
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for Clean Voice ${phase}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function processor(
	onProcess?: (signal: AbortSignal, attempt: number) => Promise<void>,
): CleanVoiceProcessor & { calls: number } {
	const result: CleanVoiceProcessor & { calls: number } = {
		calls: 0,
		async identity() {
			return engine;
		},
		async process({ stagingDir, signal }) {
			result.calls += 1;
			await onProcess?.(signal, result.calls);
			if (signal.aborted) throw new CleanVoiceCancelledError();
			const rawPath = path.join(stagingDir, "raw-microphone.wav");
			const cleanPath = path.join(stagingDir, "clean-microphone.wav");
			const previewPath = path.join(stagingDir, "preview-audio.m4a");
			await Promise.all([
				fs.writeFile(rawPath, waveBuffer(480)),
				fs.writeFile(cleanPath, waveBuffer(480)),
				fs.writeFile(previewPath, "preview"),
			]);
			return {
				rawPath,
				cleanPath,
				previewPath,
				rawSha256: await sha256File(rawPath),
				outputSha256: await sha256File(cleanPath),
				previewSha256: await sha256File(previewPath),
				previewBytes: (await fs.stat(previewPath)).size,
				engine,
				sampleRate: 48_000,
				inputSamples: 480,
				outputSamples: 480,
				delaySamples: 1_440,
				inputPeak: 0.05,
				outputPeak: 0.05,
				realTimeFactor: 0.1,
			};
		},
	};
	return result;
}

describe("CleanVoiceService", () => {
	let root: string;
	let sourcePath: string;
	const services: CleanVoiceService[] = [];

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-clean-voice-service-"));
		sourcePath = path.join(root, "recording.mp4");
		await fs.writeFile(sourcePath, "source");
	});

	afterEach(async () => {
		for (const service of services) service.dispose();
		services.length = 0;
		await fs.rm(root, { recursive: true, force: true });
	});

	it("does no work unless the asset explicitly selects Clean Voice", async () => {
		const fake = processor();
		const statuses: CleanVoiceJobStatus[] = [];
		const service = new CleanVoiceService({
			cacheRoot: path.join(root, "cache"),
			processor: fake,
			onStatus: (status) => statuses.push(status),
		});
		services.push(service);

		await service.syncDocument(documentWithRecipe(sourcePath));
		await service.syncDocument(documentWithRecipe(sourcePath, { version: 1, mode: "original" }));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(fake.calls).toBe(0);
		expect(statuses).toEqual([]);
		expect(service.getResolvedStem("project-1", "asset-1")).toBeNull();
	});

	it("publishes one validated content-addressed result and deduplicates it", async () => {
		const fake = processor();
		const statuses: CleanVoiceJobStatus[] = [];
		const service = new CleanVoiceService({
			cacheRoot: path.join(root, "cache"),
			processor: fake,
			onStatus: (status) => statuses.push(status),
		});
		services.push(service);
		const document = documentWithRecipe(sourcePath, naturalRecipe);

		await service.syncDocument(document);
		await waitFor(statuses, "ready");
		const first = service.getResolvedStem("project-1", "asset-1");
		expect(first?.path).toMatch(/entries[/\\][a-f0-9]{64}[/\\]clean-microphone\.wav$/);
		expect(first?.previewPath).toMatch(/entries[/\\][a-f0-9]{64}[/\\]preview-audio\.m4a$/);
		expect(await fs.stat(first!.path)).toBeTruthy();
		expect(await fs.stat(first!.previewPath)).toBeTruthy();
		expect(statuses.at(-1)).toMatchObject({
			phase: "ready",
			cleanMicrophonePath: first?.path,
			previewAudioPath: first?.previewPath,
			cacheKey: first?.cacheKey,
		});
		expect(service.getStatuses("project-1", ["asset-1"])).toEqual([statuses.at(-1)]);

		statuses.length = 0;
		await service.syncDocument(document);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fake.calls).toBe(1);
		expect(statuses).toEqual([]);
	});

	it("reuses a valid cache after relaunch", async () => {
		const firstProcessor = processor();
		const firstStatuses: CleanVoiceJobStatus[] = [];
		const cacheRoot = path.join(root, "cache");
		const first = new CleanVoiceService({
			cacheRoot,
			processor: firstProcessor,
			onStatus: (status) => firstStatuses.push(status),
		});
		services.push(first);
		const document = documentWithRecipe(sourcePath, naturalRecipe);
		await first.syncDocument(document);
		await waitFor(firstStatuses, "ready");
		first.dispose();

		const secondProcessor = processor();
		const secondStatuses: CleanVoiceJobStatus[] = [];
		const second = new CleanVoiceService({
			cacheRoot,
			processor: secondProcessor,
			onStatus: (status) => secondStatuses.push(status),
		});
		services.push(second);
		await second.syncDocument(document);
		await waitFor(secondStatuses, "ready");

		expect(secondProcessor.calls).toBe(0);
		expect(second.getResolvedStem("project-1", "asset-1")?.cacheKey).toBe(
			first.getResolvedStem("project-1", "asset-1")?.cacheKey,
		);
	});

	it("rejects a corrupt cached stem and rebuilds it from the raw recording", async () => {
		const cacheRoot = path.join(root, "cache");
		const document = documentWithRecipe(sourcePath, naturalRecipe);
		const firstStatuses: CleanVoiceJobStatus[] = [];
		const first = new CleanVoiceService({
			cacheRoot,
			processor: processor(),
			onStatus: (status) => firstStatuses.push(status),
		});
		services.push(first);
		await first.syncDocument(document);
		await waitFor(firstStatuses, "ready");
		const cachedPath = first.getResolvedStem("project-1", "asset-1")!.path;
		first.dispose();
		await fs.writeFile(cachedPath, "corrupt");

		const replacementProcessor = processor();
		const replacementStatuses: CleanVoiceJobStatus[] = [];
		const replacement = new CleanVoiceService({
			cacheRoot,
			processor: replacementProcessor,
			onStatus: (status) => replacementStatuses.push(status),
		});
		services.push(replacement);
		await replacement.syncDocument(document);
		await waitFor(replacementStatuses, "ready");

		expect(replacementProcessor.calls).toBe(1);
		expect(await fs.stat(replacement.getResolvedStem("project-1", "asset-1")!.path)).toBeTruthy();
	});

	it("cancels for recording and resumes after recording stops", async () => {
		const fake = processor(async (signal, attempt) => {
			if (attempt !== 1) return;
			await new Promise<void>((_resolve, reject) => {
				const abort = () => reject(new CleanVoiceCancelledError());
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		});
		const statuses: CleanVoiceJobStatus[] = [];
		const service = new CleanVoiceService({
			cacheRoot: path.join(root, "cache"),
			processor: fake,
			onStatus: (status) => statuses.push(status),
		});
		services.push(service);

		await service.syncDocument(documentWithRecipe(sourcePath, naturalRecipe));
		await waitFor(statuses, "processing");
		service.setRecordingActive(true);
		await waitFor(statuses, "cancelled");
		expect(service.getResolvedStem("project-1", "asset-1")).toBeNull();

		service.setRecordingActive(false);
		await waitFor(statuses, "ready");
		expect(fake.calls).toBe(2);
		expect(service.getResolvedStem("project-1", "asset-1")).not.toBeNull();
	});

	it("removes orphaned staging data before the next job", async () => {
		const cacheRoot = path.join(root, "cache");
		const orphan = path.join(cacheRoot, "staging", "job-from-crash", "partial.wav");
		await fs.mkdir(path.dirname(orphan), { recursive: true });
		await fs.writeFile(orphan, "partial");
		const statuses: CleanVoiceJobStatus[] = [];
		const service = new CleanVoiceService({
			cacheRoot,
			processor: processor(),
			onStatus: (status) => statuses.push(status),
		});
		services.push(service);

		await service.syncDocument(documentWithRecipe(sourcePath, naturalRecipe));
		await waitFor(statuses, "ready");
		await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

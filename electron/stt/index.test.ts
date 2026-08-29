import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planChunks } from "./chunking";
import { _resetSttManagerForTests, SttManager } from "./index";
import { ensureModels } from "./modelManager";
import type { SttStatusEvent, SttTranscribeResponse } from "./transcriptionContract";

// We swap the long-lived modules for fakes so the manager's `init()` and
// `transcribe()` paths can be exercised without spawning real processes.
const fakeWhisperServer = {
	start: vi.fn(),
	status: {
		backend: "whispercpp-cpu" as const,
		backendVerified: true,
		port: 9000,
		running: true,
		startedAtMs: 1,
		pid: 1,
		lastError: null,
	},
	transcribe: vi.fn(),
	stop: vi.fn(),
};

const { fakeParakeetHelper, resolveParakeetBinaryPath } = vi.hoisted(() => ({
	fakeParakeetHelper: {
		start: vi.fn(),
		transcribe: vi.fn(),
		restart: vi.fn(),
		stop: vi.fn(),
	},
	resolveParakeetBinaryPath: vi.fn<() => string | null>(() => null),
}));

const sourceFakes = vi.hoisted(() => {
	class MissingSourceTrackError extends Error {
		constructor(readonly sourceRole: "you" | "system" | "unknown-mixed") {
			super(`No audio track found for ${sourceRole}.`);
			this.name = "MissingSourceTrackError";
		}
	}
	return {
		extractSourceAudioChunk: vi.fn(),
		inspectSourceAudioLayout: vi.fn(),
		MissingSourceTrackError,
		sha256OfFile: vi.fn(async () => "a".repeat(64)),
	};
});

const cacheFakes = vi.hoisted(() => ({
	read: vi.fn(async () => null),
	write: vi.fn(async () => undefined),
}));

vi.mock("./parakeetHelper", () => {
	class FakeParakeetHelperManager {
		start = fakeParakeetHelper.start;
		transcribe = fakeParakeetHelper.transcribe;
		restart = fakeParakeetHelper.restart;
		stop = fakeParakeetHelper.stop;
	}
	return { ParakeetHelperManager: FakeParakeetHelperManager, resolveParakeetBinaryPath };
});

vi.mock("./whisperServer", () => {
	class FakeWhisperServerManager {
		start = fakeWhisperServer.start;
		status = fakeWhisperServer.status;
		transcribe = fakeWhisperServer.transcribe;
		stop = fakeWhisperServer.stop;
	}
	return { WhisperServerManager: FakeWhisperServerManager };
});

vi.mock("./transcriptionCache", () => ({
	TranscriptCache: class {
		read = cacheFakes.read;
		write = cacheFakes.write;
	},
}));

vi.mock("./sourceAudio", () => ({
	extractSourceAudioChunk: sourceFakes.extractSourceAudioChunk,
	inspectSourceAudioLayout: sourceFakes.inspectSourceAudioLayout,
	MissingSourceTrackError: sourceFakes.MissingSourceTrackError,
	SOURCE_SAMPLE_RATE: 16_000,
}));

vi.mock("./modelManager", () => ({
	ensureModels: vi.fn(async () => undefined),
	sha256OfFile: sourceFakes.sha256OfFile,
	STT_MODELS: {
		"parakeet-v3": {
			revision: "parakeet-revision",
			files: [{ expectedSha256: "b".repeat(64) }],
		},
		whisper: {
			revision: "whisper-revision",
			files: [{ expectedSha256: "c".repeat(64) }],
		},
	},
	modelPaths: (base: string) => ({
		"parakeet-v3": `${base}/parakeet-tdt-0.6b-v3`,
		whisper: `${base}/whisper-ggml/ggml-small-q8_0.bin`,
		"silero-vad": `${base}/silero-vad/ggml-silero-v6.2.0.bin`,
	}),
}));

vi.mock("./gpuDetector", () => ({
	detectGpuBackend: vi.fn(async () => ({ backend: "whispercpp-cpu", reason: "fake → cpu" })),
	binaryNameForBackend: () => "whisper-stt-server",
	candidateBinaryPaths: () => [] as string[],
	resolveBinaryPath: vi.fn(async () => ({
		path: "/fake/whisper-stt-server",
		backend: "whispercpp-cpu" as const,
	})),
}));

describe("SttManager", () => {
	beforeEach(() => {
		vi.mocked(ensureModels).mockReset();
		vi.mocked(ensureModels).mockResolvedValue(undefined);
		resolveParakeetBinaryPath.mockReset();
		resolveParakeetBinaryPath.mockReturnValue(null);
		fakeParakeetHelper.start.mockReset();
		fakeParakeetHelper.transcribe.mockReset();
		fakeParakeetHelper.restart.mockReset();
		fakeParakeetHelper.stop.mockReset();
		fakeParakeetHelper.start.mockResolvedValue(undefined);
		fakeParakeetHelper.restart.mockResolvedValue(undefined);
		fakeParakeetHelper.stop.mockResolvedValue(undefined);
		fakeWhisperServer.start.mockClear();
		fakeWhisperServer.transcribe.mockClear();
		fakeWhisperServer.stop.mockClear();
		fakeWhisperServer.start.mockResolvedValue({ port: 9000, backend: "whispercpp-cpu" });
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		sourceFakes.extractSourceAudioChunk.mockReset();
		sourceFakes.inspectSourceAudioLayout.mockReset();
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you", "system"],
			durationSec: 1,
		});
		sourceFakes.extractSourceAudioChunk.mockImplementation(async ({ sourceRole }) => {
			const samples = new Float32Array(16_000);
			samples[0] = sourceRole === "you" ? 1 : sourceRole === "system" ? 2 : 3;
			return samples;
		});
		sourceFakes.sha256OfFile.mockReset();
		sourceFakes.sha256OfFile.mockResolvedValue("a".repeat(64));
		cacheFakes.read.mockReset();
		cacheFakes.read.mockResolvedValue(null);
		cacheFakes.write.mockReset();
		cacheFakes.write.mockResolvedValue(undefined);
		_resetSttManagerForTests();
	});

	it("prefers the local Parakeet helper on supported Apple Silicon Macs", async () => {
		resolveParakeetBinaryPath.mockReturnValue("/fake/klippt-parakeet-stt");
		fakeParakeetHelper.transcribe.mockResolvedValue({
			segments: [{ text: "hej", startSec: 0, endSec: 0.4 }],
			wordSegments: [{ word: "hej", startSec: 0, endSec: 0.4 }],
			detectedLanguage: "sv",
			backend: "parakeet-coreml",
		});
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(16_000) });
		expect(result.backend).toBe("parakeet-coreml");
		expect(fakeParakeetHelper.transcribe).toHaveBeenCalledOnce();
		expect(fakeWhisperServer.start).not.toHaveBeenCalled();
	});

	it("falls back to Whisper when Parakeet cannot start", async () => {
		resolveParakeetBinaryPath.mockReturnValue("/fake/klippt-parakeet-stt");
		fakeParakeetHelper.start.mockRejectedValueOnce(new Error("Core ML unavailable"));
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		expect(fakeWhisperServer.start).toHaveBeenCalledOnce();
	});

	afterEach(() => {
		_resetSttManagerForTests();
	});

	it("init() forwards model + transcribe phases to the sink", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		const phases = sink.mock.calls.map(([event]) => event.phase);
		expect(phases[0]).toBe("model");
		expect(phases).toContain("transcribe");
	});

	it("transcribe() returns the server's phrase + word segments", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result: SttTranscribeResponse = await mgr.transcribe({
			samples: new Float32Array(16000),
			language: "en",
		});
		expect(result.detectedLanguage).toBe("en");
		expect(result.backend).toBe("whispercpp-cpu");
		expect(result.wordSegments).toHaveLength(1);
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("splits a long recording and shifts each chunk's timestamps to absolute time", async () => {
		// Every chunk reports the same relative segment at 1.0s; correct merging
		// turns those into one absolute timestamp per chunk start.
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 1, endSec: 1.5 }],
			wordSegments: [{ word: "hello", startSec: 1, endSec: 1.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples, language: "en" });

		const expectedOffsets = planChunks(samples, 16000).map((c) => c.startSample / 16000);
		expect(expectedOffsets.length).toBeGreaterThan(1);
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledTimes(expectedOffsets.length);
		expect(result.segments.map((s) => s.startSec)).toEqual(expectedOffsets.map((o) => o + 1));
		expect(result.wordSegments.map((w) => w.startSec)).toEqual(expectedOffsets.map((o) => o + 1));
	});

	it("reports monotonic progress that ends on the full duration", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		sink.mockClear();
		await mgr.transcribe({ samples, language: "en" });

		const progress = sink.mock.calls
			.map(([event]) => event)
			.filter((event) => event.completedSec !== undefined);
		expect(progress[0].completedSec).toBe(0);
		expect(progress[progress.length - 1].completedSec).toBe(200);
		for (const event of progress) expect(event.totalSec).toBe(200);
		for (let i = 1; i < progress.length; i++) {
			expect(progress[i].completedSec).toBeGreaterThan(progress[i - 1].completedSec ?? -1);
		}
	});

	// Both spellings of "detect it for me". `"auto"` is the one the request
	// contract documents, and it is truthy — which is exactly how it used to slip
	// past the pin and let every chunk detect its own language.
	it.each([
		["omitted", undefined] as const,
		["auto", "auto"] as const,
	])("pins later chunks to the language detected on the first one (%s)", async (_label, language) => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples: new Float32Array(200 * 16000), language });
		const languages = fakeWhisperServer.transcribe.mock.calls.map(([req]) => req.language);
		expect(languages[0]).toBeUndefined();
		expect(languages.slice(1).every((l) => l === "en")).toBe(true);
	});

	it("retries a failed chunk instead of losing the whole transcription", async () => {
		fakeWhisperServer.transcribe.mockRejectedValueOnce(new Error("helper died")).mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(result.segments).toHaveLength(1);
		// start() again on the retry — the usual cause is a dead helper.
		expect(fakeWhisperServer.start.mock.calls.length).toBeGreaterThan(1);
	});

	it("cancels promptly while a failed helper is restarting", async () => {
		fakeWhisperServer.transcribe.mockRejectedValueOnce(new Error("helper died"));
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		let restartBegan: (() => void) | undefined;
		const restarting = new Promise<void>((resolve) => {
			restartBegan = resolve;
		});
		fakeWhisperServer.start.mockImplementationOnce(
			async (_options: unknown, signal?: AbortSignal) =>
				await new Promise((_resolve, reject) => {
					restartBegan?.();
					signal?.addEventListener(
						"abort",
						() => {
							const error = new Error("cancelled");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				}),
		);
		const run = manager.transcribe({ samples: new Float32Array(16_000), language: "en" });
		await restarting;
		manager.cancel();

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("fails the request when a chunk never succeeds, saying how far it got", async () => {
		fakeWhisperServer.transcribe.mockRejectedValue(new Error("helper wedged"));
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		// 200s in, the failure is on chunk 2 of 3 — "Transcription failed" alone
		// tells the user nothing about a recording this long.
		await expect(mgr.transcribe({ samples: new Float32Array(200 * 16000) })).rejects.toThrow(
			/transcription failed \d+s into a 200s recording \(chunk 1\/3\).*helper wedged/,
		);
	});

	it("stops at the next chunk boundary when cancelled", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		// Cancel lands while the first chunk is in flight — the loop must not go on
		// to the remaining ones, which is what left "regenerate" waiting on a run
		// nobody wanted any more.
		fakeWhisperServer.transcribe.mockImplementation(async () => {
			mgr.cancel();
			return {
				segments: [],
				wordSegments: [],
				detectedLanguage: "en",
				backend: "whispercpp-cpu" as const,
			};
		});
		const samples = new Float32Array(300 * 16000);
		expect(planChunks(samples, 16000).length).toBeGreaterThan(1);

		const error = await mgr.transcribe({ samples }).catch((e: unknown) => e);
		// `AbortError` by name, so the renderer treats it as "the user asked" and
		// drops the job silently instead of toasting an engine failure.
		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("shutdown() releases the helper and lets a later request initialize it again", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.shutdown();
		expect(fakeWhisperServer.stop).toHaveBeenCalledTimes(2);
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		expect(fakeWhisperServer.start).toHaveBeenCalledTimes(2);
	});

	it("unloads an idle model and reloads it for the next request", async () => {
		vi.useFakeTimers();
		try {
			const manager = new SttManager();
			await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
			await manager.transcribe({ samples: new Float32Array(16_000) });
			expect(fakeWhisperServer.stop).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(2 * 60_000);
			expect(fakeWhisperServer.stop).toHaveBeenCalledTimes(2);
			await manager.transcribe({ samples: new Float32Array(16_000) });
			expect(fakeWhisperServer.start).toHaveBeenCalledTimes(2);
			await manager.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not activate a model whose load finishes after shutdown", async () => {
		let finishDownload: (() => void) | undefined;
		const download = new Promise<void>((resolve) => {
			finishDownload = resolve;
		});
		vi.mocked(ensureModels).mockImplementationOnce(async () => await download);
		const manager = new SttManager();
		const initialization = manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const rejection = expect(initialization).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(ensureModels).toHaveBeenCalled());
		const shutdown = manager.shutdown();
		finishDownload?.();

		await shutdown;
		await rejection;
		expect(fakeWhisperServer.start).not.toHaveBeenCalled();
	});

	it("cancels a request during shared model setup without starting audio work", async () => {
		let finishDownload: (() => void) | undefined;
		const download = new Promise<void>((resolve) => {
			finishDownload = resolve;
		});
		vi.mocked(ensureModels).mockImplementationOnce(async () => await download);
		const manager = new SttManager();
		const setup = manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const run = manager.transcribeSource({
			sourcePath: "/approved/recording.mp4",
			sourceKind: "klippt-recording",
			durationSec: 1,
		});
		await vi.waitFor(() => expect(ensureModels).toHaveBeenCalled());
		manager.cancel();

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(sourceFakes.inspectSourceAudioLayout).not.toHaveBeenCalled();
		finishDownload?.();
		await setup;
		await manager.shutdown();
	});

	it("keeps a new request cancellable while it waits for shutdown", async () => {
		let finishDownload: (() => void) | undefined;
		const download = new Promise<void>((resolve) => {
			finishDownload = resolve;
		});
		vi.mocked(ensureModels).mockImplementationOnce(async () => await download);
		const manager = new SttManager();
		const setup = manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const setupRejection = expect(setup).rejects.toMatchObject({ name: "AbortError" });
		const oldRequest = manager.transcribeSource({
			sourcePath: "/approved/old.mp4",
			sourceKind: "klippt-recording",
			durationSec: 1,
		});
		await vi.waitFor(() => expect(ensureModels).toHaveBeenCalled());
		const shutdown = manager.shutdown();
		await expect(oldRequest).rejects.toMatchObject({ name: "AbortError" });

		const nextRequest = manager.transcribeSource({
			sourcePath: "/approved/new.mp4",
			sourceKind: "klippt-recording",
			durationSec: 1,
		});
		await expect(
			manager.transcribeSource({
				sourcePath: "/approved/overlap.mp4",
				sourceKind: "klippt-recording",
				durationSec: 1,
			}),
		).rejects.toThrow("already in progress");

		finishDownload?.();
		await setupRejection;
		await shutdown;
		await expect(nextRequest).resolves.toMatchObject({ backend: "whispercpp-cpu" });
	});

	it("transcribes native microphone and system tracks independently and merges by timestamp", async () => {
		fakeWhisperServer.transcribe.mockImplementation(async ({ samples }) => {
			const isMicrophone = samples[0] === 1;
			return {
				segments: [],
				wordSegments: [
					{
						word: isMicrophone ? "mine" : "theirs",
						startSec: isMicrophone ? 0.5 : 0.2,
						endSec: isMicrophone ? 0.8 : 0.4,
						confidence: 0.9,
					},
				],
				detectedLanguage: "en",
				backend: "whispercpp-cpu" as const,
			};
		});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/recording.mp4",
			sourceKind: "klippt-recording",
			durationSec: 1,
		});

		expect(sourceFakes.extractSourceAudioChunk.mock.calls.map(([call]) => call.sourceRole)).toEqual(
			["you", "system"],
		);
		expect(result.wordSegments.map((word) => [word.word, word.sourceRole])).toEqual([
			["theirs", "system"],
			["mine", "you"],
		]);
		expect(result.sources.map((source) => source.trackLanguageCode)).toEqual(["qac", "qab"]);
		expect(result.sources.every((source) => source.sourceContentSha256 === "a".repeat(64))).toBe(
			true,
		);
	});

	it("skips an absent optional system track without falling back to mixed audio", async () => {
		sourceFakes.extractSourceAudioChunk.mockImplementation(async ({ sourceRole }) => {
			if (sourceRole === "system") throw new sourceFakes.MissingSourceTrackError("system");
			return new Float32Array(16_000);
		});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/recording.mp4",
			sourceKind: "klippt-recording",
		});

		expect(result.sources.map((source) => source.sourceRole)).toEqual(["you"]);
		expect(
			sourceFakes.extractSourceAudioChunk.mock.calls.some(
				([call]) => call.sourceRole === "unknown-mixed",
			),
		).toBe(false);
	});

	it("marks imported audio as unknown-mixed instead of guessing a speaker", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 1,
		});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/import.mp4",
			sourceKind: "import",
		});

		expect(sourceFakes.extractSourceAudioChunk).toHaveBeenCalledWith(
			expect.objectContaining({ sourceRole: "unknown-mixed" }),
		);
		expect(result.sources[0]?.sourceRole).toBe("unknown-mixed");
	});

	it("uses the spoken system track language when the microphone track is silent", async () => {
		fakeWhisperServer.transcribe.mockImplementation(async ({ samples }) => {
			const isMicrophone = samples[0] === 1;
			return {
				segments: [],
				wordSegments: isMicrophone
					? []
					: [{ word: "bonjour", startSec: 0.1, endSec: 0.5, confidence: 0.9 }],
				detectedLanguage: isMicrophone ? "auto" : "fr",
				backend: "whispercpp-cpu" as const,
			};
		});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/recording.mp4",
			sourceKind: "klippt-recording",
		});

		expect(result.detectedLanguage).toBe("fr");
	});

	it("keeps a 90-minute source memory-bounded to one short extraction window", async () => {
		const totalSec = 90 * 60;
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: totalSec,
		});
		sourceFakes.extractSourceAudioChunk.mockImplementation(
			async ({ startSec, durationSec, sourceRole }) => {
				const availableSec = Math.max(0, totalSec - startSec);
				const decodedSec = Math.min(durationSec, availableSec);
				return {
					0: sourceRole === "you" ? 1 : 2,
					length: Math.round(decodedSec * 16_000),
				} as Float32Array;
			},
		);
		fakeWhisperServer.transcribe.mockImplementation(async ({ samples }) => ({
			segments: [],
			wordSegments: [{ word: "word", startSec: 2, endSec: 2.3 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu" as const,
			sampleCount: samples.length,
		}));
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/long-recording.mp4",
			sourceKind: "klippt-recording",
			durationSec: totalSec,
		});

		const requests = sourceFakes.extractSourceAudioChunk.mock.calls.map(([request]) => request);
		expect(requests.length).toBeGreaterThan(70);
		expect(Math.max(...requests.map((request) => request.durationSec))).toBeLessThanOrEqual(78);
		expect(result.wordSegments.length).toBe(requests.length);
		expect(cacheFakes.write).toHaveBeenCalledOnce();
	});

	it("continues after an empty audio window when later source-time speech exists", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 120,
		});
		sourceFakes.extractSourceAudioChunk
			.mockResolvedValueOnce(new Float32Array())
			.mockResolvedValueOnce({ length: Math.round(46.5 * 16_000), 0: 1 } as Float32Array);
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [],
			wordSegments: [{ word: "late", startSec: 26.5, endSec: 27 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		const result = await manager.transcribeSource({
			sourcePath: "/approved/delayed-audio.mp4",
			sourceKind: "klippt-recording",
		});

		expect(sourceFakes.extractSourceAudioChunk).toHaveBeenCalledTimes(2);
		expect(result.wordSegments).toEqual([
			expect.objectContaining({ word: "late", startSec: 100, sourceRole: "you" }),
		]);
	});

	it("reconciles duplicated seam words without losing a word seen by only one window", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 80,
		});
		sourceFakes.extractSourceAudioChunk
			.mockResolvedValueOnce({ length: Math.round(76.5 * 16_000), 0: 1 } as Float32Array)
			.mockResolvedValueOnce({ length: Math.round(6.5 * 16_000), 0: 1 } as Float32Array);
		fakeWhisperServer.transcribe
			.mockResolvedValueOnce({
				segments: [],
				wordSegments: [{ word: "boundary", startSec: 74.8, endSec: 75.2, confidence: 0.7 }],
				detectedLanguage: "en",
				backend: "whispercpp-cpu",
			})
			.mockResolvedValueOnce({
				segments: [],
				wordSegments: [
					{ word: "boundary", startSec: 1.4, endSec: 1.8, confidence: 0.9 },
					{ word: "rescued", startSec: 1.9, endSec: 2.2, confidence: 0.8 },
				],
				detectedLanguage: "en",
				backend: "whispercpp-cpu",
			});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/seam-recording.mp4",
			sourceKind: "klippt-recording",
			durationSec: 80,
		});

		expect(result.wordSegments.map((word) => word.word)).toEqual(["boundary", "rescued"]);
		expect(result.wordSegments[0]?.confidence).toBe(0.9);
	});

	it("drops recognizer timestamps outside their decoded window", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 80,
		});
		sourceFakes.extractSourceAudioChunk
			.mockResolvedValueOnce({ length: Math.round(76.5 * 16_000), 0: 1 } as Float32Array)
			.mockResolvedValueOnce({ length: Math.round(6.5 * 16_000), 0: 1 } as Float32Array);
		fakeWhisperServer.transcribe
			.mockResolvedValueOnce({
				segments: [{ text: "impossible", startSec: 80, endSec: 81 }],
				wordSegments: [{ word: "impossible", startSec: 80, endSec: 81 }],
				detectedLanguage: "en",
				backend: "whispercpp-cpu",
			})
			.mockResolvedValueOnce({
				segments: [],
				wordSegments: [{ word: "real", startSec: 1.5, endSec: 2 }],
				detectedLanguage: "en",
				backend: "whispercpp-cpu",
			});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/bounded-recording.mp4",
			sourceKind: "klippt-recording",
			durationSec: 80,
		});

		expect(result.segments).toEqual([]);
		expect(result.wordSegments).toEqual([
			expect.objectContaining({ word: "real", startSec: 75, endSec: 75.5 }),
		]);
	});

	it("retries and rejects a phrase whose only apparent word is outside the decoded window", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 1,
		});
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [
				{ text: "timed", startSec: 0, endSec: 0.4 },
				{ text: "unsafe phrase", startSec: 0.5, endSec: 0.9 },
			],
			wordSegments: [
				{ word: "timed", startSec: 0, endSec: 0.4 },
				{ word: "unsafe", startSec: 2, endSec: 3 },
			],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		await expect(
			manager.transcribeSource({
				sourcePath: "/approved/phrase-only.mp4",
				sourceKind: "klippt-recording",
				durationSec: 1,
			}),
		).rejects.toThrow("without required word timestamps");
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledTimes(3);
		expect(cacheFakes.write).not.toHaveBeenCalled();
	});

	it("cancels an in-flight source extraction and never publishes a cache entry", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 90 * 60,
		});
		let extractionStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			extractionStarted = resolve;
		});
		sourceFakes.extractSourceAudioChunk.mockImplementation(
			async ({ signal }: { signal: AbortSignal }) =>
				await new Promise<Float32Array>((_resolve, reject) => {
					extractionStarted?.();
					signal.addEventListener(
						"abort",
						() => {
							const error = new Error("cancelled");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				}),
		);
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const run = manager.transcribeSource({
			sourcePath: "/approved/long-recording.mp4",
			sourceKind: "klippt-recording",
			durationSec: 90 * 60,
		});
		await started;
		manager.cancel();

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(cacheFakes.write).not.toHaveBeenCalled();
	});

	it("returns an exact cache hit without decoding the source again", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 30,
		});
		cacheFakes.read.mockResolvedValue({
			segments: [],
			wordSegments: [
				{
					word: "cached",
					startSec: 1,
					endSec: 1.4,
					sourceRole: "you",
				},
			],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
			processedSec: 30,
		});
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await manager.transcribeSource({
			sourcePath: "/approved/cached-recording.mp4",
			sourceKind: "klippt-recording",
			durationSec: 30,
		});

		expect(result.wordSegments.map((word) => word.word)).toEqual(["cached"]);
		expect(cacheFakes.read).toHaveBeenCalledWith(
			expect.objectContaining({ backend: "whispercpp-cpu" }),
			expect.any(AbortSignal),
		);
		expect(sourceFakes.extractSourceAudioChunk).not.toHaveBeenCalled();
		expect(cacheFakes.write).not.toHaveBeenCalled();
		expect(result.sources[0]?.alignment.method).toBe("recognizer-native-acoustic-snap");
	});

	it("does not cache a transcript if the source changes during recognition", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 1,
		});
		sourceFakes.sha256OfFile
			.mockResolvedValueOnce("a".repeat(64))
			.mockResolvedValueOnce("b".repeat(64));
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		await expect(
			manager.transcribeSource({
				sourcePath: "/approved/changing.mp4",
				sourceKind: "klippt-recording",
			}),
		).rejects.toThrow("changed while Klippt was transcribing");
		expect(cacheFakes.write).not.toHaveBeenCalled();
	});

	it("rejects an overlapping request instead of multiplying long-file work", async () => {
		let started: (() => void) | undefined;
		const inFlight = new Promise<void>((resolve) => {
			started = resolve;
		});
		fakeWhisperServer.transcribe.mockImplementation(
			async ({ signal }: { signal?: AbortSignal }) =>
				await new Promise<SttTranscribeResponse>((_resolve, reject) => {
					started?.();
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const first = manager.transcribe({ samples: new Float32Array(16_000) });
		await inFlight;

		await expect(manager.transcribe({ samples: new Float32Array(16_000) })).rejects.toThrow(
			"already in progress",
		);
		manager.cancel();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
	});

	it("cancels while hashing a long source before extraction starts", async () => {
		sourceFakes.inspectSourceAudioLayout.mockResolvedValue({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you"],
			durationSec: 90 * 60,
		});
		let hashStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			hashStarted = resolve;
		});
		sourceFakes.sha256OfFile.mockImplementation(
			async (_path: string, signal: AbortSignal) =>
				await new Promise<string>((_resolve, reject) => {
					hashStarted?.();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const manager = new SttManager();
		await manager.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const run = manager.transcribeSource({
			sourcePath: "/approved/long-recording.mp4",
			sourceKind: "klippt-recording",
		});
		await started;
		manager.cancel();

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(sourceFakes.extractSourceAudioChunk).not.toHaveBeenCalled();
	});

	it("retries setup after a failed one instead of caching the rejection", async () => {
		// First run downloads a 253 MB model. Caching a rejected `prepare()` meant
		// one dropped connection failed every later transcription in the session —
		// including the retry the editor offers — until the app was restarted.
		const mocked = vi.mocked(ensureModels);
		mocked.mockClear();
		mocked.mockRejectedValueOnce(new Error("Failed to download: network unreachable"));
		const mgr = new SttManager();

		await expect(mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" })).rejects.toThrow(
			"network unreachable",
		);
		// The network came back: the next attempt must actually attempt.
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		expect(mocked).toHaveBeenCalledTimes(2);
		expect(fakeWhisperServer.start).toHaveBeenCalledOnce();
	});

	it("fans status out to every sink, and detaching one leaves the others", async () => {
		const mgr = new SttManager();
		const a = vi.fn<(e: SttStatusEvent) => void>();
		const b = vi.fn<(e: SttStatusEvent) => void>();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const detachA = mgr.addStatusSink(a);
		mgr.addStatusSink(b);
		await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(a).toHaveBeenCalled();
		expect(b).toHaveBeenCalled();

		// The whole point of the Set. Two overlapping IPC requests each attach a
		// sink; when the first finishes and detaches, the second must keep getting
		// its own progress instead of falling silent for the rest of its run.
		detachA();
		a.mockClear();
		b.mockClear();
		await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalled();
	});
});

import path from "node:path";
import { app } from "electron";
import type { RendererIpcMain } from "../ipc/trustedRendererIpc";
import { planChunks } from "./chunking";
import { resolveBinaryPath } from "./gpuDetector";
import { ensureModels, modelPaths, STT_MODELS, sha256OfFile } from "./modelManager";
import { ParakeetHelperManager, resolveParakeetBinaryPath } from "./parakeetHelper";
import {
	hasCompletePhraseWordTiming,
	mergeTranscriptChunks,
	TRANSCRIPT_SEAM_VERSION,
	type TranscriptChunkResult,
} from "./seamMerge";
import {
	extractSourceAudioChunk,
	inspectSourceAudioLayout,
	MissingSourceTrackError,
	SOURCE_SAMPLE_RATE,
} from "./sourceAudio";
import { TranscriptCache, type TranscriptCacheIdentity } from "./transcriptionCache";
import type {
	SttBackend,
	SttPhraseSegment,
	SttSourceEvidence,
	SttSourceRole,
	SttStatusEvent,
	SttTranscribeRequest,
	SttTranscribeResponse,
	SttTranscribeSourceRequest,
	SttTranscribeSourceResponse,
	SttWordSegment,
} from "./transcriptionContract";
import { WhisperServerManager } from "./whisperServer";

/**
 * Owner of the long-lived STT pipeline. One instance per Electron app.
 *
 * Workflow:
 *   1. `init()` starts Parakeet/Core ML on supported Apple Silicon Macs, or the
 *      whisper.cpp compatibility helper elsewhere.
 *   2. `transcribe()` splits the renderer's `Float32Array` into chunks
 *      (`chunking.ts`) and runs each through the selected helper. Both helpers
 *      return the same phrase- and word-level contract in one pass.
 *   3. `shutdown()` tears down on app quit.
 *
 * Status events fan out to every attached sink so the renderer can drive its
 * "loading model" / "transcribing" indicator.
 *
 * Why chunked rather than one request: a 30-minute recording took ~10 minutes
 * in a single `/inference` call — no progress to show, no way to recover from a
 * transient failure without redoing everything, and long enough that the HTTP
 * client's own header timeout killed it before whisper ever answered. Chunks
 * turn that into a progress signal, a retry unit, and — via `cancel()` — the
 * only point where a run in flight can be stopped at all.
 *
 * Chunks run SEQUENTIALLY, and that is a measured choice, not an omission:
 * whisper-stt-server holds a single model context, so concurrent `/inference`
 * calls don't just serialize — they get SLOWER. Two 120s chunks took 76.9s one
 * after the other and 144.1s fired together (0.53x, i.e. ~1.9x slower) on this
 * Vulkan backend. A client-side worker pool is therefore a pessimisation. Real
 * parallelism would need several server processes, each with its own copy of
 * the model resident on the GPU; that trade (VRAM + spawn cost per worker) is
 * worth revisiting only if a much smaller model ever becomes the default.
 */

/** The renderer always sends mono 16 kHz (see `extractMono16kFromVideoUrl`). */
const SAMPLE_RATE = 16_000;

/** Attempts per chunk before the whole transcription fails. */
const CHUNK_ATTEMPTS = 3;
const SOURCE_CHUNK_SEC = 75;
const SOURCE_CONTEXT_SEC = 1.5;
const MAX_SOURCE_DURATION_SEC = 8 * 60 * 60;
const SOURCE_EXTRACTION_VERSION = 1;
const SOURCE_CHUNKING_VERSION = 1;
const SOURCE_ALIGNMENT_VERSION = 1;
const MODEL_IDLE_TIMEOUT_MS = 2 * 60_000;

/**
 * `AbortError` by name so the renderer's `isAbortError` recognizes it as "the
 * user asked for this" rather than an engine failure worth a toast.
 */
function cancelledError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelledError();
}

function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
	throwIfCancelled(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, durationMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(cancelledError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function boundRelativeTime(
	startSec: number,
	endSec: number,
	durationSec: number,
): { startSec: number; endSec: number } | null {
	if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || durationSec <= 0) return null;
	if (startSec >= durationSec) return null;
	const boundedStartSec = Math.max(0, startSec);
	return {
		startSec: boundedStartSec,
		endSec: Math.max(boundedStartSec, Math.min(durationSec, endSec)),
	};
}

function boundPhraseSegments(
	segments: SttPhraseSegment[],
	durationSec: number,
): SttPhraseSegment[] {
	return segments.flatMap((segment) => {
		const time = boundRelativeTime(segment.startSec, segment.endSec, durationSec);
		return time ? [{ ...segment, ...time }] : [];
	});
}

function boundWordSegments(words: SttWordSegment[], durationSec: number): SttWordSegment[] {
	return words.flatMap((word) => {
		if (!word.word.trim()) return [];
		const time = boundRelativeTime(word.startSec, word.endSec, durationSec);
		return time ? [{ ...word, ...time }] : [];
	});
}

export interface SttManagerInitOptions {
	statusSink?: (event: SttStatusEvent) => void;
	/** Override the models cache directory; defaults to `app.getPath("userData") + "/stt-models"`. */
	modelsBaseDir?: string;
	/** Override transcript cache storage; used by focused tests. */
	cacheBaseDir?: string;
}

export class SttManager {
	private readonly server = new WhisperServerManager();
	private readonly parakeet = new ParakeetHelperManager();
	private activeEngine: "parakeet" | "whisper" | null = null;
	private modelsBaseDir: string | null = null;
	private cacheBaseDir: string | null = null;
	private readonly statusSinks = new Set<(event: SttStatusEvent) => void>();
	private initPromise: Promise<void> | null = null;
	private shutdownPromise: Promise<void> | null = null;
	/** Kept from `prepare()` so a chunk retry can respawn a helper that died mid-run. */
	private modelPath: string | null = null;
	private parakeetModelDir: string | null = null;
	/**
	 * Bumped by `cancel()`. The chunk loop compares it against the value it
	 * captured on entry, so a cancel that lands after a new run started cannot
	 * kill that new run.
	 */
	private cancelEpoch = 0;
	/** Prevents a model load that finishes after `shutdown()` from becoming active. */
	private lifecycleEpoch = 0;
	private activeAbortController: AbortController | null = null;
	private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

	private clearIdleShutdown(): void {
		if (!this.idleShutdownTimer) return;
		clearTimeout(this.idleShutdownTimer);
		this.idleShutdownTimer = null;
	}

	private scheduleIdleShutdown(): void {
		this.clearIdleShutdown();
		this.idleShutdownTimer = setTimeout(() => {
			this.idleShutdownTimer = null;
			if (!this.activeAbortController) void this.shutdown();
		}, MODEL_IDLE_TIMEOUT_MS);
		this.idleShutdownTimer.unref?.();
	}

	/**
	 * Attach a sink for the renderer status channel; returns its detach function.
	 *
	 * A SET rather than one slot: this used to be a single field that each IPC
	 * invocation saved and restored, so with two overlapping transcriptions the
	 * first to finish restored the sink captured at ITS start and left the other
	 * one emitting into nothing — no progress for the rest of its run, which
	 * reads as a hang.
	 */
	addStatusSink(sink: (event: SttStatusEvent) => void): () => void {
		this.statusSinks.add(sink);
		return () => {
			this.statusSinks.delete(sink);
		};
	}

	private emit(event: SttStatusEvent): void {
		for (const sink of this.statusSinks) sink(event);
	}

	/**
	 * Stop the in-flight transcription at the next chunk boundary.
	 *
	 * ponytail: one epoch for the whole manager, not a handle per request. The
	 * pipeline runs one transcription at a time by construction (the renderer's
	 * queue serializes, and `WhisperServerManager` single-flights on top), so
	 * "cancel what is running" is the only question anyone can ask. Per-request
	 * tokens the day two recordings can transcribe at once.
	 */
	cancel(): void {
		this.cancelEpoch++;
		this.activeAbortController?.abort();
	}

	/**
	 * Run all one-time setup; cheap to call repeatedly — the `initPromise`
	 * means the second caller just awaits the same completion.
	 */
	init(options: SttManagerInitOptions = {}): Promise<void> {
		if (options.statusSink) this.addStatusSink(options.statusSink);
		if (options.modelsBaseDir) this.modelsBaseDir = options.modelsBaseDir;
		if (options.cacheBaseDir) this.cacheBaseDir = options.cacheBaseDir;
		if (!this.initPromise) {
			// A REJECTED init must not be cached. `prepare()` downloads the selected
			// model on first run, and caching its rejection meant one dropped
			// connection poisoned the whole app session: every later transcription
			// — including the retry the UI offers, and every remaining asset in the
			// auto-transcription queue — awaited the same stale rejection and failed
			// in milliseconds, with no way back short of quitting the app.
			// Reconnecting the network changed nothing. Clearing the slot on failure
			// makes the next attempt a real attempt.
			const initialization = (this.shutdownPromise ?? Promise.resolve())
				.catch(() => undefined)
				.then(() => this.prepare());
			let tracked: Promise<void>;
			tracked = initialization.catch((error) => {
				if (this.initPromise === tracked) this.initPromise = null;
				throw error;
			});
			this.initPromise = tracked;
		}
		return this.initPromise;
	}

	/** Await shared model setup, but let this request cancel without waiting for it. */
	private async initForRequest(signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw cancelledError();
		const initialization = this.init();
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				callback();
			};
			const onAbort = () => finish(() => reject(cancelledError()));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			initialization.then(
				() => finish(resolve),
				(error) => finish(() => reject(error)),
			);
		});
	}

	private getModelsDir(): string {
		if (this.modelsBaseDir) return this.modelsBaseDir;
		this.modelsBaseDir = path.join(app.getPath("userData"), "stt-models");
		return this.modelsBaseDir;
	}

	private getTranscriptCache(): TranscriptCache {
		if (!this.cacheBaseDir) {
			this.cacheBaseDir = path.join(path.dirname(this.getModelsDir()), "stt-cache");
		}
		return new TranscriptCache(this.cacheBaseDir);
	}

	private async prepare(): Promise<void> {
		const lifecycleEpoch = this.lifecycleEpoch;
		const assertCurrentLifecycle = () => {
			if (this.lifecycleEpoch !== lifecycleEpoch) throw cancelledError();
		};
		const modelsDir = this.getModelsDir();
		const parakeetBinary = resolveParakeetBinaryPath();
		if (parakeetBinary) {
			try {
				this.emit({ phase: "model", model: "parakeet", downloadedBytes: 0, totalBytes: 0 });
				await ensureModels({
					baseDir: modelsDir,
					only: ["parakeet-v3"],
					onProgress: (event) => {
						this.emit({
							phase: "model",
							model: "parakeet",
							downloadedBytes: event.downloadedBytes,
							totalBytes: event.totalBytes,
						});
					},
				});
				assertCurrentLifecycle();
				const paths = modelPaths(modelsDir);
				this.parakeetModelDir = paths["parakeet-v3"];
				await this.parakeet.start({
					modelDir: this.parakeetModelDir,
					binaryPath: parakeetBinary,
				});
				assertCurrentLifecycle();
				this.activeEngine = "parakeet";
				this.emit({ phase: "transcribe" });
				return;
			} catch (error) {
				if (this.lifecycleEpoch !== lifecycleEpoch) {
					await this.parakeet.stop().catch(() => undefined);
					throw cancelledError();
				}
				console.warn(
					`[stt] Parakeet unavailable; using Whisper fallback: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				await this.parakeet.stop().catch(() => undefined);
			}
		}

		this.emit({ phase: "model", model: "whisper", downloadedBytes: 0, totalBytes: 0 });
		await ensureModels({
			baseDir: modelsDir,
			only: ["whisper"],
			onProgress: (event) => {
				this.emit({
					phase: "model",
					model: "whisper",
					downloadedBytes: event.downloadedBytes,
					totalBytes: event.totalBytes,
				});
			},
		});
		assertCurrentLifecycle();

		const paths = modelPaths(modelsDir);
		this.modelPath = paths.whisper;
		await this.server.start({ modelPath: paths.whisper });
		if (this.lifecycleEpoch !== lifecycleEpoch) {
			await this.server.stop().catch(() => undefined);
			throw cancelledError();
		}
		this.activeEngine = "whisper";
		this.emit({ phase: "transcribe" });
	}

	private async restartActiveEngine(signal?: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		if (this.activeEngine === "parakeet") {
			await this.parakeet.restart(signal);
			return;
		}
		if (this.modelPath) await this.server.start({ modelPath: this.modelPath }, signal);
		throwIfCancelled(signal);
	}

	/**
	 * Run one chunk, retrying a few times before giving up on the whole request.
	 *
	 * A failure here is usually the helper process dying (OOM, driver reset)
	 * rather than a bad chunk, so each retry restarts the selected helper. That is what
	 * makes a 30-minute transcription survive a helper that dies once mid-run.
	 *
	 * What it does NOT do is salvage a chunk that fails all three attempts: the
	 * request fails whole and the chunks that already succeeded go with it. A
	 * transcript silently missing 90 seconds in the middle is worse than no
	 * transcript, since nothing downstream (captions, trims, the transcript
	 * editor) could tell the gap from a silence. The caller is told how far it
	 * got instead — see the wrapper in `transcribe()`.
	 */
	private async transcribeChunk(
		samples: Float32Array,
		language: string | undefined,
		signal?: AbortSignal,
	): Promise<SttTranscribeResponse> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
			try {
				const result =
					this.activeEngine === "parakeet"
						? await this.parakeet.transcribe({ samples, language, signal })
						: await this.server.transcribe({ samples, language, signal });
				const durationSec = samples.length / SOURCE_SAMPLE_RATE;
				const segments = boundPhraseSegments(result.segments, durationSec);
				const wordSegments = boundWordSegments(result.wordSegments, durationSec);
				if (!hasCompletePhraseWordTiming(segments, wordSegments)) {
					throw new Error("The speech recognizer returned text without required word timestamps.");
				}
				return { ...result, segments, wordSegments };
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					throw cancelledError();
				}
				lastError = error;
				if (attempt === CHUNK_ATTEMPTS) break;
				try {
					await this.restartActiveEngine(signal);
				} catch (restartError) {
					if (
						signal?.aborted ||
						(restartError instanceof Error && restartError.name === "AbortError")
					) {
						throw cancelledError();
					}
				}
				await abortableDelay(500 * attempt, signal);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	/** Transcribe a whole recording, chunk by chunk, reporting progress as it goes. */
	async transcribe(req: SttTranscribeRequest): Promise<SttTranscribeResponse> {
		const epoch = this.cancelEpoch;
		const controller = new AbortController();
		if (this.activeAbortController) {
			throw new Error("Another transcription is already in progress.");
		}
		this.clearIdleShutdown();
		this.activeAbortController = controller;
		try {
			await this.initForRequest(controller.signal);
			const totalSec = req.samples.length / SAMPLE_RATE;
			const chunks = planChunks(req.samples, SAMPLE_RATE);
			this.emit({ phase: "transcribe", completedSec: 0, totalSec });

			const segments: SttPhraseSegment[] = [];
			const wordSegments: SttWordSegment[] = [];
			let detectedLanguage: string | null = null;
			let backend: SttBackend =
				this.activeEngine === "parakeet"
					? "parakeet-coreml"
					: (this.server.status.backend ?? "whispercpp-cpu");
			// Only the first chunk auto-detects when the engine reports a language;
			// later chunks use that result, so Whisper cannot flip mid-recording on a chunk
			// that opens with a proper noun or a silence and "transcribe" the rest as
			// another language.
			//
			// `"auto"` must collapse to `undefined` here rather than merely falsy
			// values: `SttTranscribeRequest` documents it as the explicit way to ask
			// for detection, and it is TRUTHY — left in place it makes the pin below
			// unreachable for every caller that spells its intent out.
			//
			// This depends on the helper reporting what it RESOLVED rather than
			// echoing the request, which it only does since cc781806 (30/07/2026,
			// `whisper_full_lang_id()` in electron/native/whisper-stt/src/main.cpp).
			// A stale `electron/native/bin/<tag>/whisper-stt-server` — the directory
			// is gitignored, so a dev tree keeps whatever was last staged there —
			// silently reverts this to "every chunk detects on its own": the echo
			// comes back as the literal "auto", the guard below rejects it, and
			// nothing anywhere says why. `scripts/stage-whisper-stt.sh` refuses to
			// overwrite a local binary by design, so it will not rescue you either.
			// Verified end-to-end on 352s of real speech: `[undefined,"en","en","en"]`.
			let language = req.language && req.language !== "auto" ? req.language : undefined;

			for (const [index, chunk] of chunks.entries()) {
				// Between chunks is the only place this loop can be interrupted, and it
				// is enough: every native helper request has a bounded duration and timeout.
				if (this.cancelEpoch !== epoch) throw cancelledError();
				const offsetSec = chunk.startSample / SAMPLE_RATE;
				const result = await this.transcribeChunk(
					req.samples.subarray(chunk.startSample, chunk.endSample),
					language,
					controller.signal,
				).catch((error) => {
					if (
						controller.signal.aborted ||
						(error instanceof Error && error.name === "AbortError")
					) {
						throw cancelledError();
					}
					// Say where it died. Without this the user gets "Transcription
					// failed" for a 30-minute recording with no hint that 18 of those
					// minutes were fine and the helper fell over at one specific spot.
					// `Object.assign` rather than the `{ cause }` constructor option: the
					// project targets ES2020, where that overload does not exist (see
					// `BackgroundLoadError` in src/lib/wallpaper.ts for the same dance).
					throw Object.assign(
						new Error(
							`transcription failed ${Math.round(offsetSec)}s into a ${Math.round(totalSec)}s ` +
								`recording (chunk ${index + 1}/${chunks.length}): ` +
								`${error instanceof Error ? error.message : String(error)}`,
						),
						{ cause: error },
					);
				});
				// Chunk-relative timestamps → absolute, the only thing every consumer
				// (captions, transcript editor, trims) reads.
				for (const segment of result.segments) {
					segments.push({
						text: segment.text,
						startSec: segment.startSec + offsetSec,
						endSec: segment.endSec + offsetSec,
					});
				}
				for (const word of result.wordSegments) {
					wordSegments.push({
						word: word.word,
						startSec: word.startSec + offsetSec,
						endSec: word.endSec + offsetSec,
						confidence: word.confidence,
					});
				}
				if (!detectedLanguage && result.detectedLanguage && result.detectedLanguage !== "auto") {
					detectedLanguage = result.detectedLanguage;
					if (!language) language = detectedLanguage;
				}
				backend = result.backend ?? backend;
				this.emit({
					phase: "transcribe",
					completedSec: chunk.endSample / SAMPLE_RATE,
					totalSec,
				});
			}

			return {
				segments,
				wordSegments,
				detectedLanguage: detectedLanguage ?? language ?? "auto",
				backend,
			};
		} finally {
			if (this.activeAbortController === controller) {
				this.activeAbortController = null;
				this.scheduleIdleShutdown();
			}
		}
	}

	private modelEvidence(): SttSourceEvidence["model"] {
		const id = this.activeEngine === "parakeet" ? "parakeet-v3" : "whisper";
		const descriptor = STT_MODELS[id];
		return {
			id,
			revision: descriptor.revision,
			artifactSha256: descriptor.files.flatMap((file) =>
				file.expectedSha256 ? [file.expectedSha256.toLowerCase()] : [],
			),
		};
	}

	private currentBackend(): SttBackend {
		return this.activeEngine === "parakeet"
			? "parakeet-coreml"
			: (this.server.status.backend ?? "whispercpp-cpu");
	}

	private verifiedCacheBackend(): SttBackend | null {
		if (this.activeEngine === "parakeet") return "parakeet-coreml";
		return this.server.status.backendVerified ? this.server.status.backend : null;
	}

	private async transcribeSourceRole(input: {
		request: SttTranscribeSourceRequest;
		sourceRole: SttSourceRole;
		sourceContentSha256: string;
		sourceDurationSec: number;
		controller: AbortController;
		progressBaseSec: number;
		progressTotalSec: number;
	}): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		evidence: SttSourceEvidence;
		detectedLanguage: string;
		backend: SttBackend;
		processedSec: number;
		cacheIdentity: TranscriptCacheIdentity | null;
		fromCache: boolean;
	}> {
		const requestedLanguage = input.request.language ?? "auto";
		const model = this.modelEvidence();
		const cacheIdentity = (backend: SttBackend): TranscriptCacheIdentity => ({
			version: 1,
			sourceContentSha256: input.sourceContentSha256,
			sourceDurationSec: input.sourceDurationSec,
			sourceRole: input.sourceRole,
			backend,
			model,
			requestedLanguage,
			extractionVersion: SOURCE_EXTRACTION_VERSION,
			chunkingVersion: SOURCE_CHUNKING_VERSION,
			seamVersion: TRANSCRIPT_SEAM_VERSION,
			alignmentVersion: SOURCE_ALIGNMENT_VERSION,
			vocabularySha256: "none",
		});
		const cache = this.getTranscriptCache();
		const verifiedBackend = this.verifiedCacheBackend();
		const readIdentity = verifiedBackend ? cacheIdentity(verifiedBackend) : null;
		const cached = readIdentity ? await cache.read(readIdentity, input.controller.signal) : null;
		if (cached) {
			this.emit({
				phase: "transcribe",
				completedSec: input.progressBaseSec + cached.processedSec,
				totalSec: Math.max(input.progressTotalSec, input.progressBaseSec + cached.processedSec),
			});
			return {
				...cached,
				evidence: {
					sourceRole: input.sourceRole,
					trackLanguageCode:
						input.sourceRole === "you" ? "qac" : input.sourceRole === "system" ? "qab" : null,
					sourceContentSha256: input.sourceContentSha256,
					backend: cached.backend,
					model,
					language: { requested: requestedLanguage, detected: cached.detectedLanguage },
					extraction: { version: 1, sampleRate: 16_000, channels: 1 },
					alignment: {
						version: SOURCE_ALIGNMENT_VERSION,
						method: "recognizer-native-acoustic-snap",
					},
				},
				cacheIdentity: readIdentity,
				fromCache: true,
			};
		}

		const chunks: TranscriptChunkResult[] = [];
		let language =
			input.request.language && input.request.language !== "auto"
				? input.request.language
				: undefined;
		let detectedLanguage: string | null = null;
		let backend = this.currentBackend();
		let coreStartSec = 0;
		let processedSec = 0;

		while (coreStartSec < input.sourceDurationSec) {
			if (input.controller.signal.aborted) throw cancelledError();
			const decodeStartSec = Math.max(0, coreStartSec - SOURCE_CONTEXT_SEC);
			const leftContextSec = coreStartSec - decodeStartSec;
			const coreEndSec = Math.min(coreStartSec + SOURCE_CHUNK_SEC, input.sourceDurationSec);
			const requestedDurationSec = Math.min(
				leftContextSec + (coreEndSec - coreStartSec) + SOURCE_CONTEXT_SEC,
				input.sourceDurationSec - decodeStartSec,
			);
			const samples = await extractSourceAudioChunk({
				sourcePath: input.request.sourcePath,
				sourceRole: input.sourceRole,
				startSec: decodeStartSec,
				durationSec: requestedDurationSec,
				signal: input.controller.signal,
			});
			const decodedDurationSec = samples.length / SOURCE_SAMPLE_RATE;
			if (samples.length > 0) {
				const result = await this.transcribeChunk(samples, language, input.controller.signal);
				const boundedSegments = boundPhraseSegments(result.segments, decodedDurationSec);
				const boundedWords = boundWordSegments(result.wordSegments, decodedDurationSec);
				const absoluteSegments = boundedSegments.map((segment) => {
					const startSec = Math.max(0, segment.startSec + decodeStartSec);
					return {
						text: segment.text,
						startSec,
						endSec: Math.max(startSec, segment.endSec + decodeStartSec),
						sourceRole: input.sourceRole,
					};
				});
				const absoluteWords = boundedWords.map((word) => {
					const startSec = Math.max(0, word.startSec + decodeStartSec);
					return {
						word: word.word,
						startSec,
						endSec: Math.max(startSec, word.endSec + decodeStartSec),
						confidence: word.confidence,
						sourceRole: input.sourceRole,
					};
				});
				const decodeEndSec = Math.min(input.sourceDurationSec, decodeStartSec + decodedDurationSec);
				chunks.push({
					index: chunks.length,
					decodeStartSec,
					decodeEndSec,
					coreStartSec,
					coreEndSec,
					segments: absoluteSegments,
					wordSegments: absoluteWords,
				});
				if (!detectedLanguage && result.detectedLanguage && result.detectedLanguage !== "auto") {
					detectedLanguage = result.detectedLanguage;
					if (!language) language = detectedLanguage;
				}
				backend = result.backend;
			}
			processedSec = coreEndSec;
			this.emit({
				phase: "transcribe",
				completedSec: input.progressBaseSec + processedSec,
				totalSec: Math.max(input.progressTotalSec, input.progressBaseSec + processedSec),
			});
			coreStartSec = coreEndSec;
		}

		const resolvedLanguage = detectedLanguage ?? language ?? "auto";
		const merged = mergeTranscriptChunks(chunks);
		const evidence: SttSourceEvidence = {
			sourceRole: input.sourceRole,
			trackLanguageCode:
				input.sourceRole === "you" ? "qac" : input.sourceRole === "system" ? "qab" : null,
			sourceContentSha256: input.sourceContentSha256,
			backend,
			model,
			language: {
				requested: input.request.language ?? "auto",
				detected: resolvedLanguage,
			},
			extraction: { version: 1, sampleRate: 16_000, channels: 1 },
			alignment: {
				version: SOURCE_ALIGNMENT_VERSION,
				method: "recognizer-native-acoustic-snap",
			},
		};
		const result = {
			...merged,
			detectedLanguage: resolvedLanguage,
			backend,
			processedSec,
			evidence,
			cacheIdentity: this.verifiedCacheBackend() ? cacheIdentity(backend) : null,
			fromCache: false,
		};
		if (input.controller.signal.aborted) throw cancelledError();
		return result;
	}

	/** Transcribe isolated native tracks, or one explicitly mixed import, then merge by time. */
	async transcribeSource(req: SttTranscribeSourceRequest): Promise<SttTranscribeSourceResponse> {
		const controller = new AbortController();
		if (this.activeAbortController) {
			throw new Error("Another transcription is already in progress.");
		}
		this.clearIdleShutdown();
		this.activeAbortController = controller;
		try {
			await this.initForRequest(controller.signal);
			const layout = await inspectSourceAudioLayout(req.sourcePath, controller.signal);
			let roles: SttSourceRole[];
			if (layout.hasKlipptMetadata) {
				if (layout.roles.length === 0) {
					throw new Error(
						"This Klippt recording has no isolated microphone or system audio track.",
					);
				}
				roles = layout.roles;
			} else if (req.sourceKind === "klippt-recording") {
				throw new Error(
					"This Klippt recording has no verified isolated microphone or system audio track.",
				);
			} else if (layout.hasAudio) {
				roles = ["unknown-mixed"];
			} else {
				throw new Error("No audio track found in this imported media.");
			}
			const requestedDuration =
				typeof req.durationSec === "number" &&
				Number.isFinite(req.durationSec) &&
				req.durationSec > 0
					? req.durationSec
					: null;
			const sourceDurationSec = layout.durationSec ?? requestedDuration;
			if (!sourceDurationSec) {
				throw new Error("Could not determine the transcription source duration.");
			}
			if (sourceDurationSec > MAX_SOURCE_DURATION_SEC) {
				throw new Error("Transcription source exceeds the supported 8-hour duration.");
			}
			this.emit({
				phase: "transcribe",
				completedSec: 0,
				totalSec: sourceDurationSec * roles.length,
			});
			const sourceContentSha256 = await sha256OfFile(req.sourcePath, controller.signal);
			const completed: Awaited<ReturnType<SttManager["transcribeSourceRole"]>>[] = [];
			for (const sourceRole of roles) {
				try {
					completed.push(
						await this.transcribeSourceRole({
							request: req,
							sourceRole,
							sourceContentSha256,
							sourceDurationSec,
							controller,
							progressBaseSec: completed.reduce((sum, item) => sum + item.processedSec, 0),
							progressTotalSec: sourceDurationSec * roles.length,
						}),
					);
				} catch (error) {
					if (error instanceof MissingSourceTrackError && req.sourceKind === "klippt-recording") {
						continue;
					}
					throw error;
				}
			}
			if (completed.length === 0) {
				throw new Error(
					req.sourceKind === "klippt-recording"
						? "No isolated microphone or system audio track found in this Klippt recording."
						: "No audio track found in this imported media.",
				);
			}
			if (completed.some((item) => !item.fromCache)) {
				const finalSourceSha256 = await sha256OfFile(req.sourcePath, controller.signal);
				if (finalSourceSha256 !== sourceContentSha256) {
					throw new Error("The media file changed while Klippt was transcribing it. Try again.");
				}
				const cache = this.getTranscriptCache();
				for (const item of completed) {
					if (item.fromCache || !item.cacheIdentity) continue;
					try {
						await cache.write(
							item.cacheIdentity,
							{
								segments: item.segments,
								wordSegments: item.wordSegments,
								detectedLanguage: item.detectedLanguage,
								backend: item.backend,
								processedSec: item.processedSec,
							},
							controller.signal,
						);
					} catch (error) {
						if (controller.signal.aborted) throw cancelledError();
						console.warn(
							`[stt] Could not cache the completed ${item.evidence.sourceRole} transcript: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}
			}
			const rolePriority: Record<SttSourceRole, number> = {
				you: 0,
				system: 1,
				"unknown-mixed": 2,
			};
			const byTime = <T extends { startSec: number; endSec: number; sourceRole?: SttSourceRole }>(
				a: T,
				b: T,
			) =>
				a.startSec - b.startSec ||
				rolePriority[a.sourceRole ?? "unknown-mixed"] -
					rolePriority[b.sourceRole ?? "unknown-mixed"] ||
				a.endSec - b.endSec;
			const segments = completed.flatMap((item) => item.segments).sort(byTime);
			const wordSegments = completed.flatMap((item) => item.wordSegments).sort(byTime);
			const preferred =
				completed.find(
					(item) => item.evidence.sourceRole === "you" && item.wordSegments.length > 0,
				) ??
				completed.find((item) => item.wordSegments.length > 0) ??
				completed.find((item) => item.evidence.sourceRole === "you") ??
				completed[0];
			const processedSec = completed.reduce((sum, item) => sum + item.processedSec, 0);
			this.emit({ phase: "transcribe", completedSec: processedSec, totalSec: processedSec });
			return {
				segments,
				wordSegments,
				detectedLanguage: preferred.detectedLanguage,
				backend: preferred.backend,
				sources: completed.map((item) => item.evidence),
			};
		} finally {
			if (this.activeAbortController === controller) {
				this.activeAbortController = null;
				this.scheduleIdleShutdown();
			}
		}
	}

	/** Best-effort shutdown; safe to call from `before-quit` hooks. */
	async shutdown(): Promise<void> {
		this.clearIdleShutdown();
		if (this.shutdownPromise) return this.shutdownPromise;
		this.lifecycleEpoch++;
		this.cancel();
		const pendingInitialization = this.initPromise;
		this.initPromise = null;
		let shutdown: Promise<void>;
		shutdown = (async () => {
			// Stop once now, then once after a stale setup settles. The second stop
			// catches a helper that finished spawning after the first stop.
			await Promise.all([this.parakeet.stop(), this.server.stop()]);
			await pendingInitialization?.catch(() => undefined);
			await Promise.all([this.parakeet.stop(), this.server.stop()]);
			this.activeEngine = null;
			this.modelPath = null;
			this.parakeetModelDir = null;
		})().finally(() => {
			if (this.shutdownPromise === shutdown) this.shutdownPromise = null;
		});
		this.shutdownPromise = shutdown;
		return shutdown;
	}
}

let singleton: SttManager | null = null;

/** Lazy singleton for the IPC layer; processes one transcription at a time. */
export function getSttManager(): SttManager {
	if (!singleton) singleton = new SttManager();
	return singleton;
}

/** Reset the singleton — for tests. */
export function _resetSttManagerForTests(): void {
	singleton = null;
}

/**
 * Wire the IPC channels. Call this from `registerIpcHandlers` so the renderer
 * can `invoke("stt:transcribe", request)` and receive `SttTranscribeResponse`,
 * and `invoke("stt:cancel")` to stop a run it no longer wants. Status events
 * fan out on `"stt:status"` (main → renderer push), scoped to the calling
 * `webContents` so two windows don't cross-talk.
 */
export function registerSttIpc(
	ipcMain: Pick<RendererIpcMain, "handle">,
	resolveSourcePath?: (
		sourcePath: string,
	) => Promise<{ sourcePath: string; forceNative: boolean } | null>,
): void {
	const manager = getSttManager();
	ipcMain.handle("stt:is-available", async () =>
		Boolean(resolveParakeetBinaryPath() || (await resolveBinaryPath()).path),
	);
	ipcMain.handle(
		"stt:transcribe",
		async (event, req: SttTranscribeRequest): Promise<SttTranscribeResponse> => {
			const senderId = event.sender.id;
			// Attach for the life of THIS request only. Overlapping requests each
			// own their own sink, so neither can silence the other on the way out.
			const detach = manager.addStatusSink((statusEvent) => {
				if (event.sender.id === senderId && !event.sender.isDestroyed()) {
					event.sender.send("stt:status", statusEvent);
				}
			});
			try {
				return await manager.transcribe(req);
			} finally {
				detach();
			}
		},
	);
	ipcMain.handle(
		"stt:transcribe-source",
		async (event, req: SttTranscribeSourceRequest): Promise<SttTranscribeSourceResponse> => {
			const approved = await resolveSourcePath?.(req.sourcePath);
			if (!approved) throw new Error("Transcription source path is not approved.");
			const senderId = event.sender.id;
			const detach = manager.addStatusSink((statusEvent) => {
				if (event.sender.id === senderId && !event.sender.isDestroyed()) {
					event.sender.send("stt:status", statusEvent);
				}
			});
			try {
				return await manager.transcribeSource({
					...req,
					sourcePath: approved.sourcePath,
					sourceKind: approved.forceNative ? "klippt-recording" : req.sourceKind,
				});
			} finally {
				detach();
			}
		},
	);
	ipcMain.handle("stt:cancel", () => {
		manager.cancel();
	});
	ipcMain.handle("stt:release", async () => {
		await manager.shutdown();
	});
}

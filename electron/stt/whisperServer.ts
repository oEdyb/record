import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { resolveBinaryPath } from "./gpuDetector";
import { snapWordBoundariesToAudio } from "./snapWordBoundaries";
import type { SttBackend, SttPhraseSegment, SttWordSegment } from "./transcriptionContract";
import { cleanupWav, writeSamplesAsWav } from "./wav";

/** whisper.cpp helper is stdio-shaped: stdin ignored, stdout/stderr captured. */
type WhisperChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Per-request ceiling. whisper answers `/inference` only once the WHOLE upload
 * is transcribed, so this bounds one chunk, not one recording.
 *
 * ponytail: 280s because Node's global fetch (undici) applies its own
 * undocumented 300s `headersTimeout` that we cannot configure without taking a
 * direct dependency on `undici` — going over it produces an opaque
 * "TypeError: fetch failed" instead of anything actionable (this is exactly how
 * a single 30-minute request died: killed at 300s while whisper needed 574s).
 * Aborting at 280s keeps the failure OURS: named, logged with the helper's
 * stderr, and retried by SttManager. The real ceiling this leaves is a machine
 * so slow that one 90s chunk needs more than 280s (~0.3x realtime); the upgrade
 * path is a direct `undici` dependency and
 * `new Agent({ headersTimeout: 0, bodyTimeout: 0 })` as the fetch dispatcher,
 * which removes the cliff entirely.
 */
const REQUEST_TIMEOUT_MS = 280_000;

function cancelledError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(cancelledError());
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

/**
 * Owns the long-lived `whisper-stt-server` process used to recognize speech.
 *
 * Replaces the previous native STT helper with the same shape: spawn → poll
 * `/` for 200 → POST `/inference` for each transcription. The wire JSON
 * contract (`electron/stt/transcriptionContract.ts`) is **preserved**, so
 * `SttManager.transcribe()` keeps returning `SttTranscribeResponse` unchanged
 * and the renderer doesn't move.
 *
 * Word timestamps come from whisper.cpp's native DTW token timestamps
 * (`t_dtw`, SMALL aheads preset, `flash_attn = false` so DTW is actually
 * computed). The helper returns them already absolute, so no segment-offset
 * arithmetic is required.
 *
 * Concurrency: simple single-flight queue — the helper handles one inference
 * at a time anyway; serializing avoids two transcriptions stepping on each
 * other's uploads.
 */

export interface WhisperServerStartOptions {
	/** Absolute path to the GGML model file (e.g. ggml-small-q8_0.bin). */
	modelPath: string;
	/** Externally-resolved binary path (skips gpuDetector on startup); null = auto. */
	binaryPath?: string | null;
	/** Externally-resolved backend (logs only); null = auto. */
	backend?: SttBackend | null;
}

export interface WhisperServerStatus {
	running: boolean;
	pid: number | null;
	port: number | null;
	backend: SttBackend | null;
	backendVerified: boolean;
	startedAtMs: number | null;
	lastError: string | null;
}

/** Per-word entry inside a whisper-stt-server `/inference` JSON segment. */
interface WhisperJsonWord {
	word?: string;
	start?: number;
	end?: number;
	probability?: number;
}

/**
 * Phrase segment as emitted by whisper-stt-server's `/inference` JSON response.
 * `start`/`end` are the per-segment bounds from whisper.cpp's greedy decoding.
 */
interface WhisperJsonSegment {
	text?: string;
	start?: number;
	end?: number;
	words?: WhisperJsonWord[];
}

interface WhisperJsonResponse {
	segments?: WhisperJsonSegment[];
	language?: string;
	detected_language?: string;
	backend?: string;
}

export class WhisperServerManager {
	private process: WhisperChild | null = null;
	private port: number | null = null;
	private backend: SttBackend | null = null;
	private backendVerified = false;
	private lastError: string | null = null;
	private startedAtMs: number | null = null;
	private inFlight: Promise<unknown> = Promise.resolve();

	/** Buffered stderr from the helper; surfaced on shutdown + poll failures. */
	private stderrTail = "";
	private readonly stderrTailMax = 64 * 1024;

	/** Allocate a free TCP port on the loopback interface; resolves to the picked port. */
	private static async pickFreePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer();
			server.unref();
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					server.close();
					reject(new Error("Could not allocate port"));
					return;
				}
				const port = addr.port;
				server.close(() => resolve(port));
			});
		});
	}

	/** Check the server's HTTP root for a 200; resolves once responsive. */
	private static async pollUntilReady(
		baseUrl: string,
		timeoutMs = 30_000,
		signal?: AbortSignal,
	): Promise<string | null> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw cancelledError();
			try {
				const res = await fetch(baseUrl, { method: "GET", signal });
				if (res.ok) {
					const body = await res.text();
					try {
						const parsed = JSON.parse(body) as { backend?: unknown };
						return typeof parsed.backend === "string" ? parsed.backend : null;
					} catch {
						// Older helpers returned plain "ok". They remain usable, but their
						// launch backend is not trusted for transcript cache reads.
						return null;
					}
				}
			} catch {
				if (signal?.aborted) throw cancelledError();
				// not up yet
			}
			await abortableDelay(250, signal);
		}
		throw new Error(`whisper-stt-server at ${baseUrl} did not respond within ${timeoutMs}ms`);
	}

	private recordError(message: string): void {
		this.lastError = message;
	}

	/** True when a process is alive and a model is loaded. */
	get status(): WhisperServerStatus {
		return {
			running: this.process !== null && this.port !== null,
			pid: this.process?.pid ?? null,
			port: this.port,
			backend: this.backend,
			backendVerified: this.backendVerified,
			startedAtMs: this.startedAtMs,
			lastError: this.lastError,
		};
	}

	/**
	 * Spawn the helper if not running and return once `/` returns 200. Idempotent —
	 * if a server is already up we just return its port so the caller never pays
	 * the cold-start cost twice.
	 */
	async start(
		options: WhisperServerStartOptions,
		signal?: AbortSignal,
	): Promise<{ port: number; backend: SttBackend }> {
		if (signal?.aborted) throw cancelledError();
		if (this.process && this.port) {
			return { port: this.port, backend: this.backend ?? options.backend ?? "whispercpp-cpu" };
		}

		const resolved = options.binaryPath
			? { path: options.binaryPath, backend: options.backend ?? "whispercpp-cpu" }
			: await resolveBinaryPath();
		if (!resolved.path) {
			const message =
				"whisper-stt-server binary not found; build it via scripts/build-whisper-stt.sh";
			this.recordError(message);
			throw new Error(message);
		}
		try {
			if (process.platform !== "win32") {
				await access(resolved.path, fsConstants.X_OK);
			} else if (!existsSync(resolved.path)) {
				throw new Error("not found");
			}
		} catch {
			const message = `whisper-stt-server binary at ${resolved.path} is not executable`;
			this.recordError(message);
			throw new Error(message);
		}
		if (!existsSync(options.modelPath)) {
			throw new Error(`Whisper GGML model not found at ${options.modelPath}`);
		}

		const port = await WhisperServerManager.pickFreePort();
		const child = spawn(
			resolved.path,
			[
				"--model",
				options.modelPath,
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
				"--threads",
				String(Math.max(1, os.cpus().length)),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		this.process = child;
		this.port = port;
		this.backend = resolved.backend;
		this.backendVerified = false;
		this.startedAtMs = Date.now();
		this.stderrTail = "";
		this.lastError = null;
		const stopWithParent = () => {
			if (child.exitCode === null) child.kill("SIGKILL");
		};
		process.once("exit", stopWithParent);

		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(`[whisper-stt-server] ${chunk.toString()}`);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			process.stderr.write(`[whisper-stt-server] ${text}`);
			this.stderrTail = (this.stderrTail + text).slice(-this.stderrTailMax);
		});
		child.once("exit", (code) => {
			process.removeListener("exit", stopWithParent);
			if (this.process === child) {
				const reason =
					code === null
						? "exited without code"
						: `exited with code ${code}; stderr=${this.stderrTail.slice(-512)}`;
				this.recordError(reason);
				this.process = null;
				this.port = null;
				this.startedAtMs = null;
				this.backend = null;
				this.backendVerified = false;
			}
		});
		child.once("error", (err) => {
			if (this.process === child) this.recordError(`spawn error: ${err.message}`);
		});

		const baseUrl = `http://127.0.0.1:${port}`;
		try {
			const runtimeBackend = await WhisperServerManager.pollUntilReady(baseUrl, 30_000, signal);
			if (this.process === child && runtimeBackend) {
				this.backend = this.toBackend(runtimeBackend);
				this.backendVerified = true;
			}
		} catch (err) {
			await this.stopChild(child);
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (this.process !== child) {
			await this.stopChild(child);
			throw new Error("Whisper helper startup was superseded.");
		}
		return { port, backend: this.backend ?? resolved.backend };
	}

	private async stopChild(child: WhisperChild): Promise<void> {
		if (this.process === child) {
			this.process = null;
			this.port = null;
			this.startedAtMs = null;
			this.backend = null;
			this.backendVerified = false;
		}
		if (child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.kill("SIGTERM");
		try {
			await Promise.race([
				exited,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000)),
			]);
		} catch {
			child.kill("SIGKILL");
		}
	}

	/** Send SIGTERM and wait for the helper to exit. Resolves even if it was already down. */
	async stop(): Promise<void> {
		const child = this.process;
		if (!child) {
			this.port = null;
			this.startedAtMs = null;
			this.backend = null;
			this.backendVerified = false;
			return;
		}
		await this.stopChild(child);
	}

	private baseUrl(): string {
		if (!this.port) throw new Error("whisper-stt-server not started");
		return `http://127.0.0.1:${this.port}`;
	}

	private async ensureReady(): Promise<void> {
		if (!this.process || !this.port) {
			throw new Error("whisper-stt-server not started; call start() first");
		}
	}

	private toBackend(value: string | undefined): SttBackend {
		switch (value) {
			case "whispercpp-metal":
			case "whispercpp-vulkan":
			case "whispercpp-cuda":
			case "whispercpp-cpu":
				return value;
			default:
				return "whispercpp-cpu";
		}
	}

	private async runMultipartInfer(opts: {
		wavPath: string;
		language?: string;
		signal?: AbortSignal;
	}): Promise<WhisperJsonResponse> {
		await this.ensureReady();
		const url = `${this.baseUrl()}/inference`;
		const form = new FormData();
		const fileBuffer = await readFile(opts.wavPath);
		const blob = new Blob([fileBuffer], { type: "audio/wav" });
		form.set("file", blob, path.basename(opts.wavPath));
		form.set("response_format", "verbose_json");
		form.set("language", opts.language && opts.language !== "auto" ? opts.language : "auto");
		if (opts.signal?.aborted) {
			const error = new Error("Transcription cancelled");
			error.name = "AbortError";
			throw error;
		}
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			// Fetch cancellation does not stop whisper.cpp's native inference.
			void this.stop();
		}, REQUEST_TIMEOUT_MS);
		const onAbort = () => {
			controller.abort();
			void this.stop();
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.signal?.aborted) onAbort();
		try {
			const res = await fetch(url, {
				method: "POST",
				body: form,
				signal: controller.signal,
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`whisper-stt-server /inference HTTP ${res.status}: ${text.slice(0, 512)}`);
			}
			return (await res.json()) as WhisperJsonResponse;
		} catch (error) {
			if (opts.signal?.aborted) {
				const cancelled = new Error("Transcription cancelled");
				cancelled.name = "AbortError";
				throw cancelled;
			}
			// Name the failure. Node's global fetch reports BOTH a real transport
			// error and its own header timeout as a bare "fetch failed", which is
			// how a too-long request used to reach the user as an unactionable
			// "Transcription failed" toast.
			//
			// The timeout wording is reserved for an ACTUAL timeout: a helper that
			// died a moment ago rejects in a millisecond, and telling the reader it
			// spent 280s on an over-long chunk sends them to the wrong problem
			// entirely. Everything else carries its own message, plus `cause` so the
			// errno survives.
			// `Object.assign` rather than the `{ cause }` constructor option: the
			// project targets ES2020, where that overload does not exist.
			throw Object.assign(
				new Error(
					timedOut
						? `whisper-stt-server /inference timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s ` +
								`(audio chunk too long for this machine, or the helper is wedged); ` +
								`stderr=${this.stderrTail.slice(-256)}`
						: `whisper-stt-server /inference failed: ` +
								`${error instanceof Error ? error.message : String(error)}; ` +
								`stderr=${this.stderrTail.slice(-256)}`,
				),
				{ cause: error },
			);
		} finally {
			clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Defensive number parse for `verbose_json` values that may arrive as strings. */
	private toSec(value: string | number | undefined, fallback: number): number {
		if (value === undefined) return fallback;
		const n = typeof value === "string" ? Number(value) : value;
		return Number.isFinite(n) ? n : fallback;
	}

	/** Run one transcription; serializes concurrent callers. */
	async transcribe(opts: {
		samples: Float32Array;
		language?: string;
		signal?: AbortSignal;
	}): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: SttBackend;
	}> {
		const task = this.inFlight.then(() => this.transcribeImpl(opts));
		this.inFlight = task.catch(() => undefined);
		return task;
	}

	private async transcribeImpl(opts: {
		samples: Float32Array;
		language?: string;
		signal?: AbortSignal;
	}): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: SttBackend;
	}> {
		if (opts.signal?.aborted) {
			const error = new Error("Transcription cancelled");
			error.name = "AbortError";
			throw error;
		}
		const wavPath = await writeSamplesAsWav(opts.samples);
		try {
			if (opts.signal?.aborted) {
				const error = new Error("Transcription cancelled");
				error.name = "AbortError";
				throw error;
			}
			const json = await this.runMultipartInfer({
				wavPath,
				language: opts.language,
				signal: opts.signal,
			});
			const raw = json.segments ?? [];
			const segments: SttPhraseSegment[] = raw
				.map((seg) => {
					const text = (seg.text ?? "").trim();
					const startSec = this.toSec(seg.start, 0);
					const endSec = this.toSec(seg.end, startSec + 0.5);
					return { text, startSec, endSec: Math.max(endSec, startSec + 0.05) };
				})
				.filter((s) => s.text.length > 0);
			// whisper.cpp's DTW boundaries run ~80–150 ms behind the audio, which the
			// transcript editor turns into imprecise trims (see snapWordBoundaries.ts).
			// Re-anchor them on the same samples whisper was given.
			const wordSegments: SttWordSegment[] = snapWordBoundariesToAudio(
				raw
					.flatMap((seg) =>
						(seg.words ?? []).map((w) => {
							const word = (w.word ?? "").trim();
							const startSec = this.toSec(w.start, 0);
							const endSec = this.toSec(w.end, startSec + 0.05);
							const confidence = typeof w.probability === "number" ? w.probability : undefined;
							return { word, startSec, endSec: Math.max(startSec + 0.02, endSec), confidence };
						}),
					)
					.filter((w) => w.word.length > 0),
				opts.samples,
			);
			const detectedLanguage = json.detected_language ?? json.language ?? "auto";
			const backend = this.toBackend(json.backend);
			if (json.backend) {
				this.backend = backend;
				this.backendVerified = true;
			}
			return { segments, wordSegments, detectedLanguage, backend };
		} finally {
			await cleanupWav(wavPath);
		}
	}
}

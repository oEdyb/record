import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { snapWordBoundariesToAudio } from "./snapWordBoundaries";
import type { SttPhraseSegment, SttTranscribeResponse } from "./transcriptionContract";
import { cleanupWav, writeSamplesAsWav } from "./wav";

const START_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 120_000;

interface PendingRequest {
	resolve: (value: SttTranscribeResponse) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	samples: Float32Array;
	removeAbortListener: () => void;
	child: ChildProcessWithoutNullStreams;
}

interface HelperMessage {
	type?: string;
	id?: string;
	error?: string;
	segments?: SttPhraseSegment[];
	wordSegments?: SttTranscribeResponse["wordSegments"];
	detectedLanguage?: string;
	backend?: string;
}

export interface ParakeetStartOptions {
	modelDir: string;
	binaryPath?: string | null;
}

function cancelledError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

function readAppPath(): string | null {
	try {
		const { app } = require("electron") as typeof import("electron");
		return typeof app?.getAppPath === "function" ? app.getAppPath() : null;
	} catch {
		return null;
	}
}

/** Search paths mirror the other native helpers, with one explicit debug override. */
export function candidateParakeetBinaryPaths(here: string = process.cwd()): string[] {
	const name = "klippt-parakeet-stt";
	const tag = `${process.platform}-${process.arch}`;
	const appPath = readAppPath();
	const resourcesPath =
		typeof process.resourcesPath === "string" && process.resourcesPath.length > 0
			? process.resourcesPath
			: null;
	return [
		process.env.KLIPPT_PARAKEET_STT_EXE?.trim(),
		appPath ? path.join(appPath, "electron", "native", "bin", tag, name) : null,
		resourcesPath ? path.join(resourcesPath, "electron", "native", "bin", tag, name) : null,
		path.join(here, "electron", "native", "bin", tag, name),
	].filter((candidate): candidate is string => Boolean(candidate));
}

export function resolveParakeetBinaryPath(here: string = process.cwd()): string | null {
	if (process.platform !== "darwin" || process.arch !== "arm64") return null;
	// FluidAudio and the pinned Core ML graph require macOS 14. The app still
	// supports macOS 13, where SttManager falls back to whisper.cpp.
	if (Number.parseInt(release().split(".")[0] ?? "0", 10) < 23) return null;
	return candidateParakeetBinaryPaths(here).find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Owns one long-lived Core ML helper. Model state stays in that process, while
 * Electron keeps the stable STT wire contract used by Transcript and Captions.
 */
export class ParakeetHelperManager {
	private child: ChildProcessWithoutNullStreams | null = null;
	private startPromise: Promise<void> | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private lastOptions: ParakeetStartOptions | null = null;

	get running(): boolean {
		return this.child !== null && this.child.exitCode === null;
	}

	start(options: ParakeetStartOptions, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(cancelledError());
		if (this.running) return Promise.resolve();
		if (this.startPromise) return this.startPromise;
		this.lastOptions = options;
		this.startPromise = this.spawnHelper(options, signal).finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	private spawnHelper(options: ParakeetStartOptions, signal?: AbortSignal): Promise<void> {
		const binaryPath = options.binaryPath ?? resolveParakeetBinaryPath();
		if (!binaryPath) return Promise.reject(new Error("Parakeet STT helper is not available."));

		return new Promise((resolve, reject) => {
			let settled = false;
			const child = spawn(binaryPath, ["--models", options.modelDir], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
			const onAbort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				removeAbortListener();
				if (this.child === child) this.child = null;
				child.kill("SIGKILL");
				reject(cancelledError());
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				removeAbortListener();
				child.kill("SIGKILL");
				reject(new Error("Parakeet STT helper did not become ready."));
			}, START_TIMEOUT_MS);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}

			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				let message: HelperMessage;
				try {
					message = JSON.parse(line) as HelperMessage;
				} catch {
					return;
				}
				if (!settled && message.type === "ready") {
					settled = true;
					clearTimeout(timer);
					removeAbortListener();
					resolve();
					return;
				}
				if (!settled && message.type === "error" && !message.id) {
					settled = true;
					clearTimeout(timer);
					removeAbortListener();
					reject(new Error(message.error ?? "Parakeet STT helper failed to start."));
					return;
				}
				this.handleMessage(message, child);
			});

			child.stderr.on("data", (chunk: Buffer) => {
				const message = chunk.toString().trim();
				if (message) console.info(message);
			});
			child.once("error", (error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					removeAbortListener();
					reject(error);
				}
				this.failPending(error, child);
			});
			child.once("exit", (code, signal) => {
				if (this.child === child) this.child = null;
				const error = new Error(`Parakeet STT helper exited (${signal ?? code ?? "unknown"}).`);
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					removeAbortListener();
					reject(error);
				}
				this.failPending(error, child);
			});
		});
	}

	private handleMessage(message: HelperMessage, child: ChildProcessWithoutNullStreams): void {
		if (!message.id) return;
		const pending = this.pending.get(message.id);
		if (!pending || pending.child !== child) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		pending.removeAbortListener();

		if (message.type === "error") {
			pending.reject(new Error(message.error ?? "Parakeet transcription failed."));
			return;
		}
		if (message.type !== "result") {
			pending.reject(new Error("Parakeet STT helper returned an invalid response."));
			return;
		}

		// FluidAudio already removes Parakeet's measured one-frame emission delay.
		// Search half of the remaining 80 ms timestamp cell in both directions so
		// a real acoustic trough can refine the boundary without adding a new bias.
		const words = snapWordBoundariesToAudio(message.wordSegments ?? [], pending.samples, {
			lookbackSec: 0.04,
			lookaheadSec: 0.04,
		});
		pending.resolve({
			segments: message.segments ?? [],
			wordSegments: words,
			detectedLanguage: message.detectedLanguage ?? "auto",
			backend: "parakeet-coreml",
		});
	}

	private failPending(error: Error, child?: ChildProcessWithoutNullStreams): void {
		for (const [id, pending] of this.pending) {
			if (child && pending.child !== child) continue;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.removeAbortListener();
			pending.reject(error);
		}
	}

	async transcribe(request: {
		samples: Float32Array;
		language?: string;
		signal?: AbortSignal;
	}): Promise<SttTranscribeResponse> {
		if (request.signal?.aborted) throw cancelledError();
		if (!this.running) {
			if (!this.lastOptions) throw new Error("Parakeet STT helper is not initialized.");
			await this.start(this.lastOptions, request.signal);
			if (request.signal?.aborted) throw cancelledError();
		}
		const child = this.child;
		if (!child) throw new Error("Parakeet STT helper is not running.");

		const wavPath = await writeSamplesAsWav(request.samples);
		const id = randomUUID();
		try {
			if (request.signal?.aborted) throw cancelledError();
			return await new Promise<SttTranscribeResponse>((resolve, reject) => {
				const onAbort = () => {
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.removeAbortListener();
					// The helper protocol has no per-request cancellation. Stop the
					// process so Core ML cannot keep an abandoned chunk in flight.
					if (this.child === child) {
						this.child = null;
						child.kill("SIGKILL");
					}
					reject(cancelledError());
				};
				request.signal?.addEventListener("abort", onAbort, { once: true });
				const removeAbortListener = () => request.signal?.removeEventListener("abort", onAbort);
				const timer = setTimeout(() => {
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					pending.removeAbortListener();
					// The helper may still have the temporary WAV open. Kill it before
					// `finally` removes that file; the retry starts a clean process.
					if (this.child === child) {
						this.child = null;
						child.kill("SIGKILL");
					}
					reject(new Error("Parakeet transcription timed out."));
				}, REQUEST_TIMEOUT_MS);
				this.pending.set(id, {
					resolve,
					reject,
					timer,
					samples: request.samples,
					removeAbortListener,
					child,
				});
				if (request.signal?.aborted) {
					onAbort();
					return;
				}
				child.stdin.write(
					`${JSON.stringify({ id, audioPath: wavPath, language: request.language })}\n`,
					(error) => {
						if (!error) return;
						const pending = this.pending.get(id);
						if (!pending) return;
						this.pending.delete(id);
						clearTimeout(pending.timer);
						pending.removeAbortListener();
						reject(error);
					},
				);
			});
		} finally {
			await cleanupWav(wavPath);
		}
	}

	async restart(signal?: AbortSignal): Promise<void> {
		const options = this.lastOptions;
		await this.stop();
		if (signal?.aborted) throw cancelledError();
		if (options) await this.start(options, signal);
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.child = null;
		if (!child || child.exitCode !== null) return;
		child.stdin.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

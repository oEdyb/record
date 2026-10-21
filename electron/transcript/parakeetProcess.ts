import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const START_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 180_000;
/** Aligning a long recording runs window by window on the GPU: minutes, not seconds. */
const ALIGN_TIMEOUT_MS = 900_000;

export interface ParakeetTranscribeRequest {
	id: string;
	audioPath: string;
	language?: string;
}

export interface TranscriptWord {
	word: string;
	startSec: number;
	endSec: number;
	confidence: number;
}

export interface ParakeetTranscribeResult {
	id: string;
	text: string;
	/** Clip-relative word times from the recognizer, in spoken order. */
	words: TranscriptWord[];
	detectedLanguage: string | null;
}

/** A word to place on the audio, with the recognizer's own times as the starting guess. */
export interface AlignWordInput {
	word: string;
	startSec: number;
	endSec: number;
}

export interface AlignedWord {
	startSec: number;
	endSec: number;
	/** False when the aligner could not spell the word; the times are then the input times. */
	aligned: boolean;
}

export interface ParakeetAlignRequest {
	id: string;
	/** Audio file the word times are relative to (any format the helper decodes; 16 kHz mono is cheapest). */
	audioPath: string;
	words: AlignWordInput[];
	/** Directory holding the wav2vec2 Core ML aligner and its labels.json. */
	alignerModels: string;
	timeoutMs?: number;
}

export interface ParakeetAlignResult {
	id: string;
	/** Same order and count as the request's words. */
	words: AlignedWord[];
}

interface HelperMessage {
	type?: string;
	id?: string;
	error?: string;
	segments?: Array<{ text: string }>;
	wordSegments?: TranscriptWord[];
	detectedLanguage?: string;
	words?: AlignedWord[];
}

type PendingKind =
	| { kind: "transcribe"; resolve: (value: ParakeetTranscribeResult) => void }
	| { kind: "align"; expectedWords: number; resolve: (value: ParakeetAlignResult) => void };

type PendingRequest = PendingKind & {
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

function readAppPath(): string | null {
	try {
		const { app } = require("electron") as typeof import("electron");
		return typeof app?.getAppPath === "function" ? app.getAppPath() : null;
	} catch {
		return null;
	}
}

/** Same search order as the other native helpers, with one explicit debug override. */
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

/** Null on anything but Apple Silicon running macOS 14 or newer, where Core ML Parakeet runs. */
export function resolveParakeetBinaryPath(here: string = process.cwd()): string | null {
	if (process.platform !== "darwin" || process.arch !== "arm64") return null;
	if (Number.parseInt(release().split(".")[0] ?? "0", 10) < 23) return null;
	return candidateParakeetBinaryPaths(here).find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * One long-lived Core ML helper. It loads the model once and answers newline-delimited
 * JSON requests on stdin; every request resolves or rejects exactly once.
 */
export class ParakeetProcess {
	private child: ChildProcessWithoutNullStreams | null = null;
	private starting: Promise<void> | null = null;
	private readonly pending = new Map<string, PendingRequest>();

	constructor(
		private readonly options: {
			binaryPath: string;
			modelDir: string;
			spawnProcess?: typeof spawn;
			/** The first start after an update compiles the model for the Neural Engine; allow for it. */
			startTimeoutMs?: number;
		},
	) {}

	get running(): boolean {
		return this.child !== null && this.child.exitCode === null;
	}

	start(): Promise<void> {
		if (this.running) return Promise.resolve();
		if (this.starting) return this.starting;
		this.starting = this.spawnHelper().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private spawnHelper(): Promise<void> {
		return new Promise((resolve, reject) => {
			const spawnProcess = this.options.spawnProcess ?? spawn;
			const child = spawnProcess(this.options.binaryPath, ["--models", this.options.modelDir], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			let ready = false;
			const timer = setTimeout(() => {
				if (ready) return;
				child.kill("SIGKILL");
				reject(new Error("Parakeet helper did not become ready."));
			}, this.options.startTimeoutMs ?? START_TIMEOUT_MS);

			createInterface({ input: child.stdout }).on("line", (line) => {
				let message: HelperMessage;
				try {
					message = JSON.parse(line) as HelperMessage;
				} catch {
					return;
				}
				if (message.type === "ready") {
					ready = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				if (!message.id) return;
				const request = this.pending.get(message.id);
				if (!request) return;
				this.pending.delete(message.id);
				clearTimeout(request.timer);
				if (message.type === "result" && request.kind === "transcribe") {
					request.resolve({
						id: message.id,
						text: (message.segments ?? [])
							.map((segment) => segment.text)
							.join(" ")
							.trim(),
						words: message.wordSegments ?? [],
						detectedLanguage: message.detectedLanguage ?? null,
					});
				} else if (message.type === "aligned" && request.kind === "align") {
					const words = message.words ?? [];
					if (words.length === request.expectedWords) {
						request.resolve({ id: message.id, words });
					} else {
						request.reject(
							new Error(
								`Parakeet helper aligned ${words.length} words, expected ${request.expectedWords}.`,
							),
						);
					}
				} else if (message.type === "error") {
					request.reject(new Error(message.error || "Parakeet helper failed."));
				} else {
					request.reject(new Error(`Unexpected "${message.type}" reply from the Parakeet helper.`));
				}
			});
			child.stderr.on("data", () => undefined);
			child.on("error", (error) => {
				clearTimeout(timer);
				this.failAll(error);
				if (!ready) reject(error);
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				if (this.child === child) this.child = null;
				const error = new Error(`Parakeet helper exited with code ${code ?? "unknown"}.`);
				this.failAll(error);
				if (!ready) reject(error);
			});
		});
	}

	private failAll(error: Error) {
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(error);
			this.pending.delete(id);
		}
	}

	async transcribe(request: ParakeetTranscribeRequest): Promise<ParakeetTranscribeResult> {
		return this.send(request.id, REQUEST_TIMEOUT_MS, JSON.stringify(request), (resolve) => ({
			kind: "transcribe",
			resolve,
		}));
	}

	/**
	 * Forced alignment: places each word on the audio with a CTC character model, so cuts can land
	 * between words. Loads the aligner on the first call; transcription is unaffected.
	 */
	async align(request: ParakeetAlignRequest): Promise<ParakeetAlignResult> {
		const message = JSON.stringify({
			type: "align",
			id: request.id,
			audioPath: request.audioPath,
			words: request.words.map(({ word, startSec, endSec }) => ({ word, startSec, endSec })),
			alignerModels: request.alignerModels,
		});
		return this.send(request.id, request.timeoutMs ?? ALIGN_TIMEOUT_MS, message, (resolve) => ({
			kind: "align",
			expectedWords: request.words.length,
			resolve,
		}));
	}

	private async send<T>(
		id: string,
		timeoutMs: number,
		line: string,
		kind: (resolve: (value: T) => void) => PendingKind,
	): Promise<T> {
		await this.start();
		const child = this.child;
		if (!child) throw new Error("Parakeet helper is not running.");
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Parakeet helper timed out."));
			}, timeoutMs);
			this.pending.set(id, { ...kind(resolve), reject, timer });
			child.stdin.write(`${line}\n`);
		});
	}

	stop() {
		const child = this.child;
		this.child = null;
		this.failAll(new Error("Parakeet helper stopped."));
		if (child && child.exitCode === null) child.kill();
	}
}

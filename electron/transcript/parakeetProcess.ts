import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const START_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 180_000;

export interface ParakeetTranscribeRequest {
	id: string;
	audioPath: string;
	language?: string;
}

export interface ParakeetTranscribeResult {
	id: string;
	text: string;
	detectedLanguage: string | null;
}

interface HelperMessage {
	type?: string;
	id?: string;
	error?: string;
	segments?: Array<{ text: string }>;
	detectedLanguage?: string;
}

interface PendingRequest {
	resolve: (value: ParakeetTranscribeResult) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

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
			}, START_TIMEOUT_MS);

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
				if (message.type === "result") {
					request.resolve({
						id: message.id,
						text: (message.segments ?? [])
							.map((segment) => segment.text)
							.join(" ")
							.trim(),
						detectedLanguage: message.detectedLanguage ?? null,
					});
				} else {
					request.reject(new Error(message.error || "Parakeet helper failed."));
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
		await this.start();
		const child = this.child;
		if (!child) throw new Error("Parakeet helper is not running.");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request.id);
				reject(new Error("Parakeet helper timed out."));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(request.id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify(request)}\n`);
		});
	}

	stop() {
		const child = this.child;
		this.child = null;
		this.failAll(new Error("Parakeet helper stopped."));
		if (child && child.exitCode === null) child.kill();
	}
}

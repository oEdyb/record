import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { resolveBinaryPath } from "../stt/gpuDetector";
import { ensureModels, modelPaths } from "../stt/modelManager";
import { audioTrackMapArgs, resolveFfmpeg } from "./audioPeaks";

export interface SpeechActivityResult {
	probabilities: Float32Array;
	frameSec: number;
}

export interface SpeechActivityIpcResult {
	success: boolean;
	probabilities?: Float32Array;
	frameSec?: number;
	message?: string;
}

interface VadHelperReply {
	sampleRate?: number;
	frameSamples?: number;
	probabilities?: unknown;
}

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024 * 1024;
const VAD_CACHE_VERSION = "silero-v6.2.0";
const inFlight = new Map<string, Promise<SpeechActivityResult>>();

async function sourceKey(filePath: string): Promise<string> {
	const info = await stat(filePath);
	return createHash("sha1")
		.update(`${VAD_CACHE_VERSION}:${filePath}:${info.size}:${info.mtimeMs}`)
		.digest("hex")
		.slice(0, 32);
}

function cacheDir(): string | null {
	try {
		return typeof app?.getPath === "function"
			? path.join(app.getPath("userData"), "speech-activity")
			: null;
	} catch {
		return null;
	}
}

async function runProcess(command: string, args: string[], timeoutMs = PROCESS_TIMEOUT_MS) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr = "";
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`)));
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				finish(() => reject(new Error("Silero VAD helper output exceeded 64 MiB")));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4096);
		});
		child.once("error", (error) => finish(() => reject(error)));
		child.once("close", (code) => {
			finish(() => {
				if (code !== 0) {
					reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim()}`));
					return;
				}
				resolve({ stdout: Buffer.concat(stdout), stderr });
			});
		});
	});
}

export function parseVadHelperReply(value: string): SpeechActivityResult {
	const parsed = JSON.parse(value) as VadHelperReply;
	const sampleRate = parsed.sampleRate;
	const frameSamples = parsed.frameSamples;
	if (
		typeof sampleRate !== "number" ||
		!Number.isFinite(sampleRate) ||
		sampleRate <= 0 ||
		typeof frameSamples !== "number" ||
		!Number.isFinite(frameSamples) ||
		frameSamples <= 0 ||
		!Array.isArray(parsed.probabilities)
	) {
		throw new Error("Silero VAD helper returned an invalid envelope");
	}
	const probabilities = Float32Array.from(
		parsed.probabilities.map((probability) => {
			if (typeof probability !== "number" || !Number.isFinite(probability)) {
				throw new Error("Silero VAD helper returned a non-numeric probability");
			}
			return Math.min(1, Math.max(0, probability));
		}),
	);
	return { probabilities, frameSec: frameSamples / sampleRate };
}

async function analyzeUncached(filePath: string): Promise<SpeechActivityResult> {
	const ffmpeg = resolveFfmpeg();
	const helper = await resolveBinaryPath();
	if (!ffmpeg) throw new Error("FFmpeg is unavailable for speech analysis");
	if (!helper.path) throw new Error("The local speech-analysis helper is unavailable");

	const modelsDir = path.join(app.getPath("userData"), "stt-models");
	await ensureModels({ baseDir: modelsDir, only: ["silero-vad"] });
	const vadModel = modelPaths(modelsDir)["silero-vad"];
	const temporaryDir = await mkdtemp(path.join(tmpdir(), "klippt-vad-"));
	const wavPath = path.join(temporaryDir, "microphone.wav");
	try {
		await runProcess(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-i",
			filePath,
			...audioTrackMapArgs("microphone"),
			"-vn",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			"-y",
			wavPath,
		]);
		const output = await runProcess(helper.path, [
			"--vad-model",
			vadModel,
			"--vad-file",
			wavPath,
			"--threads",
			String(Math.max(1, Math.min(8, availableParallelism()))),
		]);
		return parseVadHelperReply(output.stdout.toString("utf8"));
	} finally {
		await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Dense Silero speech probabilities for the isolated microphone track. The
 * immutable source identity and model version form the disk cache key, so
 * tuning pause rules never decodes or runs the model twice.
 */
export async function getSpeechActivity(filePath: string): Promise<SpeechActivityResult> {
	const key = await sourceKey(filePath);
	const existing = inFlight.get(key);
	if (existing) return existing;
	const operation = (async () => {
		const dir = cacheDir();
		const cachePath = dir ? path.join(dir, `${key}.f32`) : null;
		if (cachePath) {
			try {
				const cached = await readFile(cachePath);
				return {
					probabilities: new Float32Array(
						cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength),
					),
					frameSec: 512 / 16_000,
				};
			} catch {
				// Cache miss.
			}
		}
		const result = await analyzeUncached(filePath);
		if (cachePath && dir) {
			await mkdir(dir, { recursive: true });
			await writeFile(cachePath, Buffer.from(result.probabilities.buffer)).catch(() => undefined);
		}
		return result;
	})();
	inFlight.set(key, operation);
	try {
		return await operation;
	} finally {
		inFlight.delete(key);
	}
}

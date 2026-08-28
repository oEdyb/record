import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { resolveBinaryPath } from "../stt/gpuDetector";
import { ensureModels, modelPaths } from "../stt/modelManager";
import { audioTrackMapArgs, resolveFfmpeg } from "./audioPeaks";

export interface SpeechActivityResult {
	probabilities: Float32Array;
	cleanedProbabilities?: Float32Array;
	frameSec: number;
}

export interface SpeechActivityIpcResult {
	success: boolean;
	probabilities?: Float32Array;
	cleanedProbabilities?: Float32Array;
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
const VAD_CACHE_VERSION = "silero-v6.2.0-afftdn12-v1";
const CACHE_MAGIC = "KPV2";
const CACHE_HEADER_BYTES = 16;
const CLEANED_ANALYSIS_FILTER = "afftdn=nr=12:nf=-80:tn=1:gs=5";
const inFlight = new Map<string, Promise<SpeechActivityResult>>();

interface SourceFileIdentity {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

export function sourceIdentityKey(filePath: string, info: SourceFileIdentity): string {
	return createHash("sha256")
		.update(
			`${VAD_CACHE_VERSION}:${path.resolve(filePath)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
		)
		.digest("hex")
		.slice(0, 32);
}

async function sourceKey(filePath: string): Promise<string> {
	return sourceIdentityKey(filePath, await stat(filePath, { bigint: true }));
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

export function serializeSpeechActivityCache(result: SpeechActivityResult): Buffer {
	const raw = Buffer.from(
		result.probabilities.buffer,
		result.probabilities.byteOffset,
		result.probabilities.byteLength,
	);
	const cleaned = result.cleanedProbabilities
		? Buffer.from(
				result.cleanedProbabilities.buffer,
				result.cleanedProbabilities.byteOffset,
				result.cleanedProbabilities.byteLength,
			)
		: Buffer.alloc(0);
	const header = Buffer.alloc(CACHE_HEADER_BYTES);
	header.write(CACHE_MAGIC, 0, "ascii");
	header.writeUInt32LE(result.probabilities.length, 4);
	header.writeUInt32LE(result.cleanedProbabilities?.length ?? 0, 8);
	header.writeFloatLE(result.frameSec, 12);
	return Buffer.concat([header, raw, cleaned]);
}

export function parseSpeechActivityCache(buffer: Buffer): SpeechActivityResult {
	if (buffer.length < CACHE_HEADER_BYTES || buffer.toString("ascii", 0, 4) !== CACHE_MAGIC) {
		throw new Error("Speech activity cache has an invalid header");
	}
	const rawLength = buffer.readUInt32LE(4);
	const cleanedLength = buffer.readUInt32LE(8);
	const frameSec = buffer.readFloatLE(12);
	const expectedBytes =
		CACHE_HEADER_BYTES + (rawLength + cleanedLength) * Float32Array.BYTES_PER_ELEMENT;
	if (
		rawLength === 0 ||
		buffer.length !== expectedBytes ||
		!Number.isFinite(frameSec) ||
		frameSec <= 0
	) {
		throw new Error("Speech activity cache has an invalid shape");
	}
	const readEnvelope = (offset: number, length: number): Float32Array => {
		const start = buffer.byteOffset + offset;
		const values = new Float32Array(buffer.buffer.slice(start, start + length * 4));
		for (const value of values) {
			if (!Number.isFinite(value) || value < 0 || value > 1) {
				throw new Error("Speech activity cache contains an invalid probability");
			}
		}
		return values;
	};
	const probabilities = readEnvelope(CACHE_HEADER_BYTES, rawLength);
	const cleanedProbabilities =
		cleanedLength > 0
			? readEnvelope(CACHE_HEADER_BYTES + rawLength * Float32Array.BYTES_PER_ELEMENT, cleanedLength)
			: undefined;
	if (cleanedProbabilities && Math.abs(cleanedProbabilities.length - probabilities.length) > 1) {
		throw new Error("Speech activity cache envelopes use different source clocks");
	}
	return { probabilities, cleanedProbabilities, frameSec };
}

export function shouldPersistSpeechActivityCache(result: SpeechActivityResult): boolean {
	return Boolean(result.cleanedProbabilities?.length);
}

export function speechEnvelopeCoversDuration(
	result: Pick<SpeechActivityResult, "probabilities" | "frameSec">,
	durationSec: number,
): boolean {
	return (
		Number.isFinite(durationSec) &&
		durationSec >= 0 &&
		result.frameSec > 0 &&
		result.probabilities.length * result.frameSec + result.frameSec >= durationSec
	);
}

async function readPcmWaveDurationSec(filePath: string): Promise<number> {
	const handle = await open(filePath, "r");
	try {
		const fileSize = (await handle.stat()).size;
		const riff = Buffer.alloc(12);
		const riffRead = await handle.read(riff, 0, riff.length, 0);
		if (
			riffRead.bytesRead !== riff.length ||
			riff.toString("ascii", 0, 4) !== "RIFF" ||
			riff.toString("ascii", 8, 12) !== "WAVE"
		) {
			throw new Error("Speech-analysis input is not a PCM WAVE file");
		}

		let sampleRate = 0;
		let blockAlign = 0;
		let dataBytes = -1;
		let offset = 12;
		while (offset + 8 <= fileSize) {
			const chunkHeader = Buffer.alloc(8);
			const chunkRead = await handle.read(chunkHeader, 0, chunkHeader.length, offset);
			if (chunkRead.bytesRead !== chunkHeader.length) break;
			const chunkId = chunkHeader.toString("ascii", 0, 4);
			const declaredSize = chunkHeader.readUInt32LE(4);
			const chunkStart = offset + 8;
			const availableSize = Math.max(0, Math.min(declaredSize, fileSize - chunkStart));
			if (chunkId === "fmt " && availableSize >= 16) {
				const format = Buffer.alloc(16);
				await handle.read(format, 0, format.length, chunkStart);
				sampleRate = format.readUInt32LE(4);
				blockAlign = format.readUInt16LE(12);
			} else if (chunkId === "data") {
				dataBytes = availableSize;
			}
			if (sampleRate > 0 && blockAlign > 0 && dataBytes >= 0) break;
			offset = chunkStart + declaredSize + (declaredSize % 2);
		}
		if (sampleRate <= 0 || blockAlign <= 0 || dataBytes < 0) {
			throw new Error("Speech-analysis WAVE file has no readable PCM data");
		}
		return dataBytes / blockAlign / sampleRate;
	} finally {
		await handle.close();
	}
}

async function writeCacheAtomically(filePath: string, value: Buffer): Promise<void> {
	const directory = path.dirname(filePath);
	const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(16)
		.slice(2)}`;
	await mkdir(directory, { recursive: true });
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(value);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, filePath);
		if (process.platform !== "win32") {
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		}
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
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
	const cleanedWavPath = path.join(temporaryDir, "microphone-cleaned.wav");
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
		const sourceDurationSec = await readPcmWaveDurationSec(wavPath);
		const output = await runProcess(helper.path, [
			"--vad-model",
			vadModel,
			"--vad-file",
			wavPath,
			"--threads",
			String(Math.max(1, Math.min(8, availableParallelism()))),
		]);
		const raw = parseVadHelperReply(output.stdout.toString("utf8"));
		if (!speechEnvelopeCoversDuration(raw, sourceDurationSec)) {
			throw new Error("Raw speech analysis does not cover the decoded microphone");
		}
		try {
			await runProcess(ffmpeg, [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-i",
				wavPath,
				"-vn",
				"-af",
				CLEANED_ANALYSIS_FILTER,
				"-c:a",
				"pcm_s16le",
				"-y",
				cleanedWavPath,
			]);
			const cleanedOutput = await runProcess(helper.path, [
				"--vad-model",
				vadModel,
				"--vad-file",
				cleanedWavPath,
				"--threads",
				String(Math.max(1, Math.min(8, availableParallelism()))),
			]);
			const cleaned = parseVadHelperReply(cleanedOutput.stdout.toString("utf8"));
			if (Math.abs(cleaned.frameSec - raw.frameSec) > 0.000_001) {
				throw new Error("Cleaned speech analysis returned a different frame clock");
			}
			if (Math.abs(cleaned.probabilities.length - raw.probabilities.length) > 1) {
				throw new Error("Cleaned speech analysis returned a different source length");
			}
			if (!speechEnvelopeCoversDuration(cleaned, sourceDurationSec)) {
				throw new Error("Cleaned speech analysis does not cover the decoded microphone");
			}
			return { ...raw, cleanedProbabilities: cleaned.probabilities };
		} catch {
			// The raw envelope remains valid when an older packaged FFmpeg does not
			// carry afftdn. Callers then keep every microphone-energy event protected.
			return raw;
		}
	} finally {
		await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Dense Silero probabilities for the raw isolated microphone and a moderate
 * analysis-only denoise of the same samples. The immutable source identity,
 * model, and filter version form the disk cache key, so tuning pause rules does
 * not decode or run either envelope twice.
 */
export async function getSpeechActivity(filePath: string): Promise<SpeechActivityResult> {
	const key = await sourceKey(filePath);
	const existing = inFlight.get(key);
	if (existing) return existing;
	const operation = (async () => {
		const dir = cacheDir();
		const cachePath = dir ? path.join(dir, `${key}.bin`) : null;
		if (cachePath) {
			try {
				return parseSpeechActivityCache(await readFile(cachePath));
			} catch {
				// Cache miss.
			}
		}
		const result = await analyzeUncached(filePath);
		if (cachePath && dir && shouldPersistSpeechActivityCache(result)) {
			await writeCacheAtomically(cachePath, serializeSpeechActivityCache(result)).catch(
				() => undefined,
			);
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

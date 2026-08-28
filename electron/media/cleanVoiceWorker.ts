import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { constants as osConstants, setPriority } from "node:os";
import path from "node:path";
import type { CleanVoiceRecipe } from "../../src/lib/ai-edition/schema";
import { audioTrackMapArgs } from "./audioPeaks";

const EXPECTED_ENGINE_ID = "deepfilternet3-libdf-v0.5.6-klippt-silence-grace-v1";
const EXPECTED_ENGINE_COMMIT = "b0fa238a331fb5cc39c5555d3538008dd88c0aef";
const EXPECTED_MODEL_SHA256 = "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616";
const REQUIRED_SAMPLE_RATE = 48_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const EXTRACTION_TIMEOUT_MS = 30 * 60_000;
const MIN_ENHANCEMENT_TIMEOUT_MS = 5 * 60_000;
const MAX_ENHANCEMENT_TIMEOUT_MS = 60 * 60_000;
const TERMINATION_GRACE_MS = 1_500;

export interface CleanVoiceEngineIdentity {
	id: string;
	commit: string;
	modelSha256: string;
	helperSha256: string;
}

export interface WaveInfo {
	sampleRate: number;
	channels: number;
	sampleCount: number;
	dataBytes: number;
}

export interface CleanVoiceArtifact {
	rawPath: string;
	cleanPath: string;
	previewPath: string;
	rawSha256: string;
	outputSha256: string;
	previewSha256: string;
	previewBytes: number;
	engine: CleanVoiceEngineIdentity;
	sampleRate: number;
	inputSamples: number;
	outputSamples: number;
	delaySamples: number;
	inputPeak: number;
	outputPeak: number;
	realTimeFactor: number;
}

export interface CleanVoiceProcessor {
	identity(): Promise<CleanVoiceEngineIdentity>;
	process(input: {
		sourcePath: string;
		recipe: Extract<CleanVoiceRecipe, { mode: "natural" }>;
		stagingDir: string;
		signal: AbortSignal;
	}): Promise<CleanVoiceArtifact>;
}

export class CleanVoiceCancelledError extends Error {
	constructor(message = "Clean Voice was cancelled") {
		super(message);
		this.name = "CleanVoiceCancelledError";
	}
}

interface HelperReport {
	engineId?: unknown;
	engineCommit?: unknown;
	modelSha256?: unknown;
	sampleRate?: unknown;
	inputSamples?: unknown;
	outputSamples?: unknown;
	delaySamples?: unknown;
	attenuationLimitDb?: unknown;
	inputPeak?: unknown;
	outputPeak?: unknown;
	realTimeFactor?: unknown;
}

interface ParsedHelperReport {
	engineId: string;
	engineCommit: string;
	modelSha256: string;
	sampleRate: number;
	inputSamples: number;
	outputSamples: number;
	delaySamples: number;
	attenuationLimitDb: number;
	inputPeak: number;
	outputPeak: number;
	realTimeFactor: number;
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Clean Voice helper returned an invalid ${name}`);
	}
	return value;
}

function integer(value: unknown, name: string): number {
	const number = finiteNumber(value, name);
	if (!Number.isInteger(number) || number < 0) {
		throw new Error(`Clean Voice helper returned an invalid ${name}`);
	}
	return number;
}

function parseHelperReport(stdout: Buffer): ParsedHelperReport {
	const parsed = JSON.parse(stdout.toString("utf8")) as HelperReport;
	if (
		parsed.engineId !== EXPECTED_ENGINE_ID ||
		parsed.engineCommit !== EXPECTED_ENGINE_COMMIT ||
		parsed.modelSha256 !== EXPECTED_MODEL_SHA256
	) {
		throw new Error("Clean Voice helper identity does not match the pinned engine");
	}
	return {
		engineId: parsed.engineId,
		engineCommit: parsed.engineCommit,
		modelSha256: parsed.modelSha256,
		sampleRate: integer(parsed.sampleRate, "sample rate"),
		inputSamples: integer(parsed.inputSamples, "input sample count"),
		outputSamples: integer(parsed.outputSamples, "output sample count"),
		delaySamples: integer(parsed.delaySamples, "delay sample count"),
		attenuationLimitDb: finiteNumber(parsed.attenuationLimitDb, "attenuation limit"),
		inputPeak: finiteNumber(parsed.inputPeak, "input peak"),
		outputPeak: finiteNumber(parsed.outputPeak, "output peak"),
		realTimeFactor: finiteNumber(parsed.realTimeFactor, "real-time factor"),
	};
}

export async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
	const handle = await open(filePath, "r");
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		let position = 0;
		for (;;) {
			if (signal?.aborted) throw new CleanVoiceCancelledError();
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		if (signal?.aborted) throw new CleanVoiceCancelledError();
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

export async function readWaveInfo(filePath: string): Promise<WaveInfo> {
	const handle = await open(filePath, "r");
	try {
		const fileSize = (await handle.stat()).size;
		const riff = Buffer.alloc(12);
		if ((await handle.read(riff, 0, riff.length, 0)).bytesRead !== riff.length) {
			throw new Error("Clean Voice WAV header is truncated");
		}
		if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE") {
			throw new Error("Clean Voice artifact is not a WAVE file");
		}

		let sampleRate = 0;
		let channels = 0;
		let blockAlign = 0;
		let dataBytes = -1;
		let offset = 12;
		while (offset + 8 <= fileSize) {
			const header = Buffer.alloc(8);
			if ((await handle.read(header, 0, header.length, offset)).bytesRead !== header.length) break;
			const id = header.toString("ascii", 0, 4);
			const declaredSize = header.readUInt32LE(4);
			const dataOffset = offset + 8;
			const available = Math.max(0, Math.min(declaredSize, fileSize - dataOffset));
			if (id === "fmt " && available >= 16) {
				const format = Buffer.alloc(16);
				await handle.read(format, 0, format.length, dataOffset);
				channels = format.readUInt16LE(2);
				sampleRate = format.readUInt32LE(4);
				blockAlign = format.readUInt16LE(12);
			} else if (id === "data") {
				dataBytes = available;
			}
			if (sampleRate > 0 && channels > 0 && blockAlign > 0 && dataBytes >= 0) break;
			offset = dataOffset + declaredSize + (declaredSize % 2);
		}
		if (sampleRate <= 0 || channels <= 0 || blockAlign <= 0 || dataBytes < 0) {
			throw new Error("Clean Voice WAV has no readable PCM data");
		}
		if (dataBytes % blockAlign !== 0) {
			throw new Error("Clean Voice WAV contains a partial audio frame");
		}
		return { sampleRate, channels, sampleCount: dataBytes / blockAlign, dataBytes };
	} finally {
		await handle.close();
	}
}

async function runProcess(
	command: string,
	args: string[],
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<{ stdout: Buffer; stderr: string }> {
	if (options.signal.aborted) throw new CleanVoiceCancelledError();
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	if (child.pid) {
		try {
			setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
		} catch {
			// A denied nice request is not a processing failure. The one-job queue
			// and recording/thermal cancellation remain the hard resource limits.
		}
	}

	return new Promise((resolve, reject) => {
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr = "";
		let terminalError: Error | null = null;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | null = null;

		const terminate = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, TERMINATION_GRACE_MS);
			forceKillTimer.unref();
		};
		const onAbort = () => {
			terminalError = new CleanVoiceCancelledError();
			terminate();
		};
		const timer = setTimeout(() => {
			terminalError = new Error(
				`${path.basename(command)} timed out after ${options.timeoutMs} ms`,
			);
			terminate();
		}, options.timeoutMs);
		timer.unref();
		options.signal.addEventListener("abort", onAbort, { once: true });

		const finish = (operation: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal.removeEventListener("abort", onAbort);
			operation();
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_STDOUT_BYTES) {
				terminalError = new Error(`${path.basename(command)} output exceeded 1 MiB`);
				terminate();
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_BYTES);
		});
		child.once("error", (error) => finish(() => reject(error)));
		child.once("close", (code) => {
			finish(() => {
				if (terminalError) {
					reject(terminalError);
					return;
				}
				if (code !== 0) {
					reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim()}`));
					return;
				}
				resolve({ stdout: Buffer.concat(stdout), stderr });
			});
		});
	});
}

async function executable(candidate: string): Promise<string | null> {
	try {
		const info = await stat(candidate);
		if (!info.isFile()) return null;
		await access(candidate, fsConstants.X_OK);
		return candidate;
	} catch {
		return null;
	}
}

export async function resolveCleanVoiceHelper(candidates: string[]): Promise<string | null> {
	for (const candidate of candidates) {
		const found = await executable(candidate);
		if (found) return found;
	}
	return null;
}

export function cleanVoiceHelperCandidates(appPath: string, resourcesPath: string): string[] {
	const name = process.platform === "win32" ? "klippt-clean-voice.exe" : "klippt-clean-voice";
	return [
		path.join(appPath, "electron", "native", "clean-voice", "build", name),
		path.join(resourcesPath, "electron", "native", "clean-voice", name),
	];
}

export function createLocalCleanVoiceProcessor(options: {
	ffmpegPath: string;
	helperPath: string;
}): CleanVoiceProcessor {
	let identityPromise: Promise<CleanVoiceEngineIdentity> | null = null;
	const identity = () => {
		identityPromise ??= sha256File(options.helperPath).then((helperSha256) => ({
			id: EXPECTED_ENGINE_ID,
			commit: EXPECTED_ENGINE_COMMIT,
			modelSha256: EXPECTED_MODEL_SHA256,
			helperSha256,
		}));
		return identityPromise;
	};

	return {
		identity,
		async process({ sourcePath, recipe, stagingDir, signal }) {
			const rawPath = path.join(stagingDir, "raw-microphone.wav");
			const cleanPath = path.join(stagingDir, "clean-microphone.wav");
			const previewPath = path.join(stagingDir, "preview-audio.m4a");
			await runProcess(
				options.ffmpegPath,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-nostdin",
					"-i",
					sourcePath,
					...audioTrackMapArgs("microphone"),
					"-vn",
					"-ac",
					"1",
					"-ar",
					String(REQUIRED_SAMPLE_RATE),
					"-c:a",
					"pcm_f32le",
					"-y",
					rawPath,
				],
				{ signal, timeoutMs: EXTRACTION_TIMEOUT_MS },
			);
			const input = await readWaveInfo(rawPath);
			if (input.sampleRate !== REQUIRED_SAMPLE_RATE || input.channels !== 1) {
				throw new Error("Clean Voice extraction did not produce mono 48 kHz audio");
			}
			const [engine, rawSha256] = await Promise.all([identity(), sha256File(rawPath, signal)]);
			const audioDurationMs = (input.sampleCount / REQUIRED_SAMPLE_RATE) * 1000;
			const timeoutMs = Math.min(
				MAX_ENHANCEMENT_TIMEOUT_MS,
				Math.max(MIN_ENHANCEMENT_TIMEOUT_MS, audioDurationMs / 2),
			);
			const result = await runProcess(
				options.helperPath,
				[
					"--input",
					rawPath,
					"--output",
					cleanPath,
					"--attenuation-limit-db",
					String(recipe.attenuationLimitDb),
				],
				{ signal, timeoutMs },
			);
			const report = parseHelperReport(result.stdout);
			const output = await readWaveInfo(cleanPath);
			if (
				report.sampleRate !== REQUIRED_SAMPLE_RATE ||
				output.sampleRate !== REQUIRED_SAMPLE_RATE ||
				output.channels !== 1 ||
				report.inputSamples !== input.sampleCount ||
				report.outputSamples !== input.sampleCount ||
				output.sampleCount !== input.sampleCount ||
				Math.abs(report.attenuationLimitDb - recipe.attenuationLimitDb) > 0.000_1
			) {
				throw new Error("Clean Voice output does not match the source-time contract");
			}

			// The hidden HTML video is the editor's source clock. When Clean Voice is
			// active it must be muted, otherwise its mixed track would double the
			// microphone. Build one browser-ready replacement from the verified clean
			// microphone plus the untouched tagged system-audio track. A source without
			// system audio is a normal voice-only recording, so only that exact missing-map
			// error may fall back to the clean microphone alone.
			try {
				await runProcess(
					options.ffmpegPath,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-nostdin",
						"-i",
						sourcePath,
						"-i",
						cleanPath,
						"-filter_complex",
						"[0:m:language:qab]aresample=48000[bed];[1:a:0]aresample=48000[voice];[bed][voice]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0[out]",
						"-map",
						"[out]",
						"-vn",
						"-ar",
						String(REQUIRED_SAMPLE_RATE),
						"-ac",
						"2",
						"-c:a",
						"aac",
						"-b:a",
						"256k",
						"-movflags",
						"+faststart",
						"-y",
						previewPath,
					],
					{ signal, timeoutMs: EXTRACTION_TIMEOUT_MS },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("matches no streams")) throw error;
				await runProcess(
					options.ffmpegPath,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-nostdin",
						"-i",
						cleanPath,
						"-map",
						"0:a:0",
						"-vn",
						"-ar",
						String(REQUIRED_SAMPLE_RATE),
						"-ac",
						"2",
						"-c:a",
						"aac",
						"-b:a",
						"256k",
						"-movflags",
						"+faststart",
						"-y",
						previewPath,
					],
					{ signal, timeoutMs: EXTRACTION_TIMEOUT_MS },
				);
			}
			const preview = await stat(previewPath);
			if (!preview.isFile() || preview.size <= 0) {
				throw new Error("Clean Voice preview audio is empty");
			}
			return {
				rawPath,
				cleanPath,
				previewPath,
				rawSha256,
				outputSha256: await sha256File(cleanPath, signal),
				previewSha256: await sha256File(previewPath, signal),
				previewBytes: preview.size,
				engine,
				sampleRate: output.sampleRate,
				inputSamples: input.sampleCount,
				outputSamples: output.sampleCount,
				delaySamples: report.delaySamples,
				inputPeak: report.inputPeak,
				outputPeak: report.outputPeak,
				realTimeFactor: report.realTimeFactor,
			};
		},
	};
}

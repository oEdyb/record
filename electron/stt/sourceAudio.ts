import { spawn } from "node:child_process";

import { audioTrackMapArgs, resolveFfmpeg } from "../media/audioPeaks";
import type { SttSourceRole } from "./transcriptionContract";

export const SOURCE_SAMPLE_RATE = 16_000 as const;
const SOURCE_PROBE_TIMEOUT_MS = 10_000;

const TRACK_TITLE_BY_LANGUAGE = {
	qaa: "screenrec.mix.v1",
	qab: "screenrec.system.v1",
	qac: "screenrec.microphone.v1",
} as const;

type KlipptTrackLanguage = keyof typeof TRACK_TITLE_BY_LANGUAGE;

export interface SourceAudioLayout {
	hasAudio: boolean;
	hasKlipptMetadata: boolean;
	roles: SttSourceRole[];
	durationSec: number | null;
}

/** Raised only when the requested source track does not exist in the container. */
export class MissingSourceTrackError extends Error {
	constructor(readonly sourceRole: SttSourceRole) {
		super(`No ${sourceRole} audio track found in this recording.`);
		this.name = "MissingSourceTrackError";
	}
}

function cancelledError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

/**
 * Parse the input-stream section emitted by the pinned FFmpeg binary.
 *
 * AVAssetWriter's language tag is the durable identity. FFmpeg 8.1.2 does not
 * expose the common-title metadata written by ScreenCaptureKit on every MP4,
 * but when a title is present it must agree with that language tag. A duplicate
 * private role or a conflicting title is rejected instead of guessing.
 */
export function parseSourceAudioLayout(ffmpegStderr: string): SourceAudioLayout {
	const inputSection = ffmpegStderr.split(/^Stream mapping:/m, 1)[0] ?? ffmpegStderr;
	const durationMatch = /^\s*Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/m.exec(inputSection);
	const durationSec = durationMatch
		? Number(durationMatch[1]) * 3_600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
		: null;
	const streamStarts = [
		...inputSection.matchAll(/^\s*Stream #0:\d+(?:\[[^\]]+\])?(?:\(([^)]+)\))?: Audio:/gm),
	];
	const counts = new Map<KlipptTrackLanguage, number>();

	for (const [index, match] of streamStarts.entries()) {
		const language = match[1]?.toLowerCase();
		if (language !== "qaa" && language !== "qab" && language !== "qac") continue;
		counts.set(language, (counts.get(language) ?? 0) + 1);
		const blockEnd = streamStarts[index + 1]?.index ?? inputSection.length;
		const block = inputSection.slice(match.index, blockEnd);
		const title = /^\s*title\s*:\s*(.+)$/im.exec(block)?.[1]?.trim();
		if (title && title !== TRACK_TITLE_BY_LANGUAGE[language]) {
			throw new Error(`Conflicting Klippt audio metadata: ${language} is titled ${title}.`);
		}
	}

	for (const language of ["qaa", "qab", "qac"] as const) {
		if ((counts.get(language) ?? 0) > 1) {
			throw new Error(`Conflicting Klippt audio metadata: duplicate ${language} tracks.`);
		}
	}

	const roles: SttSourceRole[] = [];
	if (counts.has("qac")) roles.push("you");
	if (counts.has("qab")) roles.push("system");
	return {
		hasAudio: streamStarts.length > 0,
		hasKlipptMetadata: counts.size > 0,
		roles,
		durationSec:
			durationSec !== null && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
	};
}

/** Inspect only container headers; no audio packets are decoded. */
export async function inspectSourceAudioLayout(
	sourcePath: string,
	signal?: AbortSignal,
): Promise<SourceAudioLayout> {
	if (signal?.aborted) throw cancelledError();
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable for transcription.");
	const args = [
		"-hide_banner",
		"-nostdin",
		"-i",
		sourcePath,
		"-map",
		"0:a?",
		"-t",
		"0",
		"-c",
		"copy",
		"-f",
		"null",
		"-",
	];

	return await new Promise<SourceAudioLayout>((resolve, reject) => {
		const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], signal });
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error("FFmpeg timed out while inspecting transcription tracks.")));
		}, SOURCE_PROBE_TIMEOUT_MS);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-64 * 1024);
		});
		child.once("error", (error) => {
			finish(() => {
				if (signal?.aborted || error.name === "AbortError") reject(cancelledError());
				else reject(error);
			});
		});
		child.once("close", (code) => {
			finish(() => {
				if (signal?.aborted) return reject(cancelledError());
				if (code !== 0) {
					reject(new Error(`FFmpeg could not inspect transcription tracks: ${stderr.trim()}`));
					return;
				}
				try {
					resolve(parseSourceAudioLayout(stderr));
				} catch (error) {
					reject(error);
				}
			});
		});
	});
}

export function sourceTrackMapArgs(role: SttSourceRole): string[] {
	if (role === "you") return audioTrackMapArgs("microphone");
	if (role === "system") return audioTrackMapArgs("system");
	// Imported media is explicitly mixed. Pick its first audio stream instead of
	// relying on FFmpeg's automatic selection, which can change with dispositions.
	return ["-map", "0:a:0"];
}

export interface SourceAudioChunkRequest {
	sourcePath: string;
	sourceRole: SttSourceRole;
	startSec: number;
	durationSec: number;
	signal?: AbortSignal;
}

/**
 * Decode one bounded source-time window to mono 16 kHz float PCM.
 *
 * The child runs outside Electron's renderer and stdout is consumed as it is
 * produced. The returned allocation is therefore bounded by `durationSec`, not
 * by the recording length. `-map` stays required so qac/qab can never fall back
 * to the mixed preview track.
 */
export async function extractSourceAudioChunk(
	request: SourceAudioChunkRequest,
): Promise<Float32Array> {
	if (request.signal?.aborted) throw cancelledError();
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable for transcription.");
	if (!Number.isFinite(request.startSec) || request.startSec < 0) {
		throw new Error("Invalid transcription chunk start.");
	}
	if (!Number.isFinite(request.durationSec) || request.durationSec <= 0) {
		throw new Error("Invalid transcription chunk duration.");
	}

	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-ss",
		request.startSec.toFixed(6),
		"-i",
		request.sourcePath,
		"-t",
		request.durationSec.toFixed(6),
		...sourceTrackMapArgs(request.sourceRole),
		"-vn",
		"-sn",
		"-dn",
		"-ac",
		"1",
		"-af",
		`aresample=${SOURCE_SAMPLE_RATE}:async=1:first_pts=0`,
		"-c:a",
		"pcm_f32le",
		"-f",
		"f32le",
		"pipe:1",
	];

	return await new Promise<Float32Array>((resolve, reject) => {
		const child = spawn(ffmpeg, args, {
			stdio: ["ignore", "pipe", "pipe"],
			signal: request.signal,
		});
		const chunks: Buffer[] = [];
		let byteLength = 0;
		let stderr = "";
		let settled = false;
		const maximumBytes =
			Math.ceil(request.durationSec * SOURCE_SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT) +
			SOURCE_SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};
		child.stdout.on("data", (chunk: Buffer) => {
			byteLength += chunk.byteLength;
			if (byteLength > maximumBytes) {
				child.kill("SIGKILL");
				finish(() => reject(new Error("FFmpeg exceeded the bounded transcription chunk size.")));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-16_384);
		});
		child.once("error", (error) => {
			finish(() => {
				if (request.signal?.aborted || error.name === "AbortError") reject(cancelledError());
				else reject(error);
			});
		});
		child.once("close", (code) => {
			finish(() => {
				if (request.signal?.aborted) {
					reject(cancelledError());
					return;
				}
				if (code !== 0) {
					if (/matches no streams|stream map .* matches no streams/i.test(stderr)) {
						reject(new MissingSourceTrackError(request.sourceRole));
						return;
					}
					reject(new Error(`FFmpeg audio extraction failed: ${stderr.trim() || `exit ${code}`}`));
					return;
				}
				const pcm = Buffer.concat(chunks, byteLength - (byteLength % 4));
				const aligned = Uint8Array.from(pcm);
				resolve(new Float32Array(aligned.buffer));
			});
		});
	});
}

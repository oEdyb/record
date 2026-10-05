import { spawn } from "node:child_process";

import { audioTrackMapArgs, resolveFfmpeg } from "../media/audioPeaks";
import type { SttSourceRole } from "./transcriptionContract";

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
	video?: { codec: string; width: number; height: number; fps: number };
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
	const videoLine = /^\s*Stream #0:\d+[^\n]*: Video: ([^\n]+)/m.exec(inputSection)?.[1];
	const dimensions = videoLine && /(?:^|, )([1-9]\d*)x([1-9]\d*)(?:[ ,]|$)/.exec(videoLine);
	const fps = videoLine && /([\d.]+) fps/.exec(videoLine);
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
		...(dimensions
			? {
					video: {
						codec: videoLine!.split(/[ ,]/)[0],
						width: Number(dimensions[1]),
						height: Number(dimensions[2]),
						fps: fps ? Number(fps[1]) : 0,
					},
				}
			: {}),
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

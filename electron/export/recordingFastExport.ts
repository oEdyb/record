import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveFfmpeg } from "../media/audioPeaks";
import type { ExportStats } from "../native/compositor-view/addon";
import { parseSourceAudioLayout } from "../stt/sourceAudio";
import {
	canPreserveRecordingSource,
	type RecordingPassthroughRequest,
} from "./recordingPassthrough";

function abortError(): Error {
	return Object.assign(new Error("Recording export cancelled."), { name: "AbortError" });
}

/** Wait for close, including on abort/error, before allowing staging cleanup.
 * Node's error event can precede the child exiting and closing its file handles. */
export async function runRecordingFfmpeg(
	ffmpeg: string,
	args: string[],
	signal: AbortSignal,
	timeoutMs: number,
	onStdout?: (chunk: string) => void,
): Promise<string> {
	if (signal.aborted) throw abortError();
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			signal,
			killSignal: "SIGKILL",
		});
		let stderr = "";
		let failure: Error | undefined;
		const timer = setTimeout(() => {
			failure = new Error("FFmpeg timed out while preparing the recording export.");
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			try {
				onStdout?.(chunk.toString());
			} catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-64 * 1024);
		});
		child.once("error", (error) => {
			failure ??= error;
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (signal.aborted) reject(abortError());
			else if (failure) reject(failure);
			else if (code !== 0) reject(new Error(`Could not preserve the recording: ${stderr.trim()}`));
			else resolve(stderr);
		});
	});
}

export interface RecordingSourceMetadata {
	codec: "h264" | "hevc";
	width: number;
	height: number;
	/** Nominal time base cadence; sparse ScreenCaptureKit frames are variable-rate. */
	fps: number;
	audioStreamIndex: number | null;
}

/** Parse the pinned FFmpeg header format, declining ambiguous/unsupported media.
 * A qaa track is the capture's intended mix. Never choose an arbitrary isolated
 * microphone/system track from a multitrack recording. */
export function parseRecordingSourceMetadata(stderr: string): RecordingSourceMetadata | null {
	try {
		parseSourceAudioLayout(stderr); // Reject duplicate/conflicting capture role metadata.
		const input = stderr.split(/^Stream mapping:/m, 1)[0]!;
		const start = /^\s*Duration:[^\n]*, start: ([\d.-]+)/m.exec(input);
		if (
			!start ||
			Number(start[1]) !== 0 ||
			/(?:rotation of|displaymatrix:|rotate\s*:)/i.test(input)
		)
			return null;
		const videoLines = [...input.matchAll(/^\s*Stream #0:\d+[^\n]*: Video: ([^\n]+)/gm)];
		if (videoLines.length !== 1) return null;
		const video = videoLines[0]![1]!;
		const codec = /^(h264|hevc)(?:[ ,]|$)/.exec(video)?.[1];
		const dimensions = /(?:^|, )([1-9]\d*)x([1-9]\d*)(?:[ ,]|$)/.exec(video);
		const cadence = /([\d.]+) tbr/.exec(video) ?? /([\d.]+) fps/.exec(video);
		const sar = /SAR ([\d]+):([\d]+)/.exec(video);
		if (
			!codec ||
			!dimensions ||
			!cadence ||
			!/(?:^|, )yuv420p(?:\(|,| )/.test(video) ||
			/\b(?:interlaced|top first|bottom first)\b/i.test(video) ||
			(sar && sar[1] !== sar[2])
		)
			return null;
		const fps = Number(cadence[1]);
		if (!Number.isFinite(fps) || fps <= 0) return null;
		const audio = [
			...input.matchAll(/^\s*Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?: Audio: ([^\n]+)/gm),
		];
		const mixed = audio.filter((entry) => entry[2]?.toLowerCase() === "qaa");
		const selected = mixed.length === 1 ? mixed[0] : audio.length === 1 ? audio[0] : undefined;
		if (audio.length && !selected) return null;
		if (selected && !/^aac \(LC\)(?: \([^)]*\))?, 48000 Hz, stereo(?:,|$)/.test(selected[3]!))
			return null;
		return {
			codec: codec as "h264" | "hevc",
			width: Number(dimensions[1]),
			height: Number(dimensions[2]),
			fps,
			audioStreamIndex: selected ? Number(selected[1]) : null,
		};
	} catch {
		return null;
	}
}

export interface RecordingFastExportPlan {
	expectedBytes: number;
	/** Completed staging stream's nominal cadence, which remuxing may change
	 * without changing any encoded packet or presentation timestamp. */
	fps: number;
	durationS: number;
	render: (
		stagingPath: string,
		signal: AbortSignal,
		onProgress?: (frames: number) => void,
	) => Promise<ExportStats>;
}

export interface RecordingVideoPacketProof {
	frames: number;
	digest: string;
	/** Cadence from actual packet presentation span, independent of container tbr. */
	averageFps: number | null;
}

/** The proof guards against a remux changing packets, not against an attacker,
 * so it uses a fast non-cryptographic 128-bit hash. SHA-256 bound the pass to
 * one CPU core (about 60 s for a 35 GB recording). */
const PACKET_HASH = "murmur3";
const PACKET_HASH_PATTERN = /^[a-f0-9]{32}$/i;

/** Streaming proof of encoded packet identity and original PTS/DTS. Framehash
 * with `-c:v copy` never decodes/re-encodes video. Normalize timestamp units
 * because MP4 remuxing may rescale the same timestamps into a new time base. */
export class RecordingVideoPacketAccumulator {
	private readonly hash = createHash("sha256");
	private pending = "";
	private timeBase: { numerator: number; denominator: number } | null = null;
	private frames = 0;
	private firstPts = Number.POSITIVE_INFINITY;
	private lastPts = Number.NEGATIVE_INFINITY;

	append(chunk: string): void {
		this.pending += chunk;
		const lines = this.pending.split("\n");
		this.pending = lines.pop() ?? "";
		for (const line of lines) {
			const timeBase = /^#tb 0:\s*(\d+)\/(\d+)/.exec(line);
			if (timeBase) {
				this.timeBase = { numerator: Number(timeBase[1]), denominator: Number(timeBase[2]) };
				continue;
			}
			if (!line.trim() || line.startsWith("#")) continue;
			const fields = line.split(",").map((field) => field.trim());
			if (
				fields.length < 6 ||
				fields[0] !== "0" ||
				!this.timeBase ||
				!this.timeBase.numerator ||
				!this.timeBase.denominator ||
				!PACKET_HASH_PATTERN.test(fields[5]!)
			) {
				throw new Error("Unable to prove recording video packet identity.");
			}
			const [dts, pts, bytes] = [Number(fields[1]), Number(fields[2]), Number(fields[4])];
			if (![dts, pts, bytes].every(Number.isSafeInteger) || bytes <= 0)
				throw new Error("Invalid recording video packet timestamps.");
			const secondsPerTick = this.timeBase.numerator / this.timeBase.denominator;
			const dtsNs = Math.round(dts * secondsPerTick * 1_000_000_000);
			const ptsNs = Math.round(pts * secondsPerTick * 1_000_000_000);
			if (![dtsNs, ptsNs].every(Number.isSafeInteger))
				throw new Error("Recording timestamps exceed safe packet verification range.");
			this.hash.update(`${dtsNs},${ptsNs},${bytes},${fields[5]}\n`);
			this.frames++;
			this.firstPts = Math.min(this.firstPts, ptsNs);
			this.lastPts = Math.max(this.lastPts, ptsNs);
		}
	}

	/** Presentation time covered so far, for progress while the pass runs. */
	get spanSeconds(): number {
		return this.lastPts > this.firstPts ? (this.lastPts - this.firstPts) / 1_000_000_000 : 0;
	}

	finish(): RecordingVideoPacketProof {
		if (this.pending.trim() || !this.frames)
			throw new Error("Incomplete recording video packet proof.");
		return {
			frames: this.frames,
			digest: this.hash.digest("hex"),
			averageFps:
				this.lastPts > this.firstPts
					? ((this.frames - 1) * 1_000_000_000) / (this.lastPts - this.firstPts)
					: null,
		};
	}
}

/** Apple's AudioToolbox AAC encoder, in the bundled macOS FFmpeg, encodes a
 * 40-minute stereo track in 40 s; FFmpeg's own AAC encoder takes 263 s. */
const AAC_ENCODER = process.platform === "darwin" ? "aac_at" : "aac";

/** Time limit for one full pass over the recording: never less than 30 minutes,
 * and enough for a slow external disk reading 20 MB/s. */
function passTimeoutMs(bytes: number): number {
	return Math.max(30 * 60_000, Math.ceil(bytes / 20_000));
}

function videoHashArgs(): string[] {
	return ["-map", "0:v:0", "-c:v", "copy", "-f", "framehash", "-hash", PACKET_HASH, "pipe:1"];
}

async function probeRecordingPackets(
	ffmpeg: string,
	file: string,
	signal: AbortSignal,
	timeoutMs: number,
	onSpan?: (seconds: number) => void,
) {
	const packets = new RecordingVideoPacketAccumulator();
	const header = await runRecordingFfmpeg(
		ffmpeg,
		["-copyts", "-i", file, ...videoHashArgs()],
		signal,
		timeoutMs,
		(chunk) => {
			packets.append(chunk);
			onSpan?.(packets.spanSeconds);
		},
	);
	return { header, packets: packets.finish() };
}

interface RecordingClipHeader {
	media: RecordingSourceMetadata;
	durationSec: number | null;
	/** Codec configuration and time base; joined takes must share both. */
	streamIdentity: string;
}

/** Reads one video packet: enough for the container header, the codec
 * configuration hash and the stream time base, without a pass over the file. */
async function inspectRecordingClip(
	ffmpeg: string,
	file: string,
	signal: AbortSignal,
): Promise<RecordingClipHeader | null> {
	let stdout = "";
	const header = await runRecordingFfmpeg(
		ffmpeg,
		["-copyts", "-i", file, "-frames:v", "1", ...videoHashArgs()],
		signal,
		60_000,
		(chunk) => {
			stdout += chunk;
		},
	);
	const media = parseRecordingSourceMetadata(header);
	const identity = stdout
		.split("\n")
		.filter((line) => /^#(?:extradata|tb|codec_id|dimensions|sar) 0:?/.test(line))
		.join("\n");
	if (!media || !identity.includes("#tb 0")) return null;
	return {
		media,
		durationSec: parseSourceAudioLayout(header).durationSec,
		streamIdentity: identity,
	};
}

/** FFmpeg concat list. Single quotes close, escape and reopen the quoted path. */
function concatList(files: string[]): string | null {
	if (files.some((file) => /[\r\n]/.test(file))) return null;
	return files.map((file) => `file '${file.split("'").join("'\\''")}'\n`).join("");
}

export type RecordingFastExportRequest = Omit<RecordingPassthroughRequest, "hasCursorTrack"> & {
	signal: AbortSignal;
	/** Receives progress on the same frame scale as a rendered export. */
	onProgress?: (frames: number) => void;
};

/** The source-preserving path copies the recording while hashing what it read,
 * then reads the copy back. Report the two passes as equal halves of one bar,
 * scaled to the frame total the renderer expects for this duration and rate. */
function fastExportProgress(durationS: number, fps: number) {
	const total = Math.max(1, Math.round(durationS * fps));
	let last = -1;
	let lastAt = 0;
	return (onProgress: ((frames: number) => void) | undefined, pass: 0 | 1, fraction: number) => {
		if (!onProgress) return;
		const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
		const frames = Math.min(total, Math.round(((pass + clamped) / 2) * total));
		const now = performance.now();
		if (frames <= last || (now - lastAt < 100 && frames < total)) return;
		last = frames;
		lastAt = now;
		onProgress(frames);
	};
}

async function hasCursorSidecar(screenPath: string): Promise<boolean> {
	return await fs
		.stat(`${screenPath}.cursor.json`)
		.then(() => true)
		.catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		});
}

/** Cheap checks only: eligibility, file sizes and one packet per take. Every
 * full pass over the recording runs inside `render`, after the export has
 * confirmed there is room for it. */
export async function prepareRecordingFastExport(
	request: RecordingFastExportRequest,
): Promise<RecordingFastExportPlan | null> {
	if (!canPreserveRecordingSource({ ...request, hasCursorTrack: false })) return null;
	if (request.signal.aborted) throw abortError();
	const { clips } = request;
	const sidecars = await Promise.all(clips.map((clip) => hasCursorSidecar(clip.screenPath)));
	if (!canPreserveRecordingSource({ ...request, hasCursorTrack: sidecars.some(Boolean) }))
		return null;
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return null;
	const sources = await Promise.all(clips.map((clip) => fs.stat(clip.screenPath)));
	if (!sources.every((source) => source.isFile())) return null;
	const headers: RecordingClipHeader[] = [];
	for (const clip of clips) {
		const header = await inspectRecordingClip(ffmpeg, clip.screenPath, request.signal);
		if (!header) return null;
		headers.push(header);
	}
	const params = request.params!;
	const first = headers[0]!;
	const media = first.media;
	const silentClip = clips.map(
		(clip, index) => !clip.hasAudio || headers[index]!.media.audioStreamIndex === null,
	);
	if (
		media.width !== params.width ||
		media.height !== params.height ||
		media.codec !== (params.codec === "h265" ? "hevc" : "h264") ||
		headers.some(
			(header) =>
				header.streamIdentity !== first.streamIdentity ||
				header.media.codec !== media.codec ||
				header.media.audioStreamIndex !== media.audioStreamIndex,
		) ||
		silentClip.some((silent) => silent !== silentClip[0])
	)
		return null;
	const joined = clips.length > 1;
	const list = joined ? concatList(clips.map((clip) => path.resolve(clip.screenPath))) : "";
	if (list === null) return null;
	const silence = silentClip[0]!;
	const durationS = request.sourceDurationsSec.reduce((sum, duration) => sum + duration, 0);
	const sourceBytes = sources.reduce((sum, source) => sum + source.size, 0);
	const timeoutMs = passTimeoutMs(sourceBytes);
	const report = fastExportProgress(durationS, params.fps ?? 60);
	// Reserve the index at the front instead of +faststart, which rewrites the
	// whole file a second time to move it there. A sample costs at most 44 bytes
	// of size, timing, sync and chunk entries; 64 leaves margin, and muxing
	// fails rather than truncating.
	// The frame bound doubles the nominal rate, capped where a closing sample makes
	// it read 600, because a variable-rate capture can run above its nominal rate;
	// slack covers the closing samples themselves.
	const audioPackets = Math.ceil((durationS * 48_000) / 1024) + clips.length;
	const videoPackets = Math.ceil(2 * durationS * Math.min(media.fps, 120)) + 600 * clips.length;
	const moovBytes = 64 * (videoPackets + audioPackets) + 1024 * 1024;
	let verificationFps = media.fps;
	return {
		expectedBytes:
			sourceBytes + Math.ceil(silence || joined ? (durationS * 384_000) / 8 : 0) + moovBytes,
		get fps() {
			return verificationFps;
		},
		durationS,
		render: async (stagingPath, signal, onProgress) => {
			const start = performance.now();
			const listPath = joined
				? path.join(os.tmpdir(), `klippt-concat-${process.pid}-${randomUUID()}.txt`)
				: null;
			try {
				if (listPath) await fs.writeFile(listPath, list, { flag: "wx", mode: 0o600 });
				const args = ["-v", "error", "-n", "-copyts"];
				// auto_convert would rewrite H.264 packets to Annex B and back, adding
				// parameter sets to the first keyframe; joined takes share one codec
				// configuration, so packets pass through unchanged.
				if (listPath) args.push("-f", "concat", "-safe", "0", "-auto_convert", "0", "-i", listPath);
				else args.push("-i", clips[0]!.screenPath);
				// Bound only the synthetic audio input. An output-wide -t would
				// discard a closing video packet whose PTS equals container duration.
				if (silence)
					args.push("-f", "lavfi", "-t", String(durationS), "-i", "anullsrc=r=48000:cl=stereo");
				args.push(
					"-map",
					"0:v:0",
					"-map",
					silence ? "1:a:0" : `0:${media.audioStreamIndex}`,
					"-c:v",
					"copy",
				);
				if (media.codec === "hevc") args.push("-tag:v", "hvc1");
				if (silence) args.push("-c:a", AAC_ENCODER, "-b:a", "384k", "-ar", "48000", "-ac", "2");
				else if (joined)
					// Each take's audio starts where its take starts. Fill or trim the few
					// milliseconds where a take's audio and video lengths differ, so sync
					// never drifts across joins.
					args.push(
						"-af",
						"aresample=async=1:min_hard_comp=0.005:first_pts=0",
						"-c:a",
						AAC_ENCODER,
						"-b:a",
						"384k",
						"-ar",
						"48000",
						"-ac",
						"2",
					);
				else args.push("-c:a", "copy");
				args.push("-moov_size", String(moovBytes), "-sn", "-dn", stagingPath, ...videoHashArgs());
				const read = new RecordingVideoPacketAccumulator();
				const header = await runRecordingFfmpeg(ffmpeg, args, signal, timeoutMs, (chunk) => {
					read.append(chunk);
					report(onProgress, 0, read.spanSeconds / durationS);
				});
				const original = read.finish();
				const staged = await probeRecordingPackets(ffmpeg, stagingPath, signal, timeoutMs, (s) =>
					report(onProgress, 1, s / durationS),
				);
				const stagedMedia = parseRecordingSourceMetadata(staged.header);
				// FFmpeg's human-readable duration is rounded to hundredths; allow
				// at most two display quanta per take, alongside exact packet proof.
				const originalDuration = joined
					? headers.every((clip) => clip.durationSec !== null)
						? headers.reduce((sum, clip) => sum + clip.durationSec!, 0)
						: null
					: (parseSourceAudioLayout(header).durationSec ?? first.durationSec);
				const stagedDuration = parseSourceAudioLayout(staged.header).durationSec;
				if (
					!stagedMedia ||
					stagedMedia.width !== media.width ||
					stagedMedia.height !== media.height ||
					stagedMedia.codec !== media.codec ||
					stagedMedia.audioStreamIndex === null ||
					(originalDuration !== null &&
						stagedDuration !== null &&
						Math.abs(originalDuration - stagedDuration) > 0.020000001 * clips.length) ||
					staged.packets.frames !== original.frames ||
					staged.packets.digest !== original.digest ||
					staged.packets.averageFps !== original.averageFps
				) {
					throw new Error(
						"Source-preserving export changed recording video packets or timestamps.",
					);
				}
				// A last closing sample can make input r_frame_rate/tbr read 600 even
				// though ~58 frames/s were recorded. Remuxing normalizes that guess.
				// Packet/timestamp proof above establishes cadence preservation; the
				// native verifier still checks the staged stream's actual nominal FPS.
				verificationFps = stagedMedia.fps;
				const wallS = (performance.now() - start) / 1000;
				report(onProgress, 1, 1);
				return {
					frames: original.frames,
					wallS,
					fps: original.frames / Math.max(wallS, 0.000001),
					videoDurationS: durationS,
					audioMastering: {
						enabled: false,
						analyzed: false,
						appliedGainDb: 0,
						limitedByTruePeak: false,
						limitedByGainCap: false,
					},
					encoderName: `stream-copy/${media.codec}`,
					encoderHardware: false,
					encoderFallback: false,
					decoderPath: joined ? "packet-concat" : "packet-copy",
					compositorBackend: "bypassed-identity-scene",
				};
			} finally {
				if (listPath) await fs.rm(listPath, { force: true });
			}
		},
	};
}

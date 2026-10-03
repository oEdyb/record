import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
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
				!/^[a-f0-9]{64}$/i.test(fields[5]!)
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

async function probeRecordingPackets(ffmpeg: string, file: string, signal: AbortSignal) {
	const packets = new RecordingVideoPacketAccumulator();
	const header = await runRecordingFfmpeg(
		ffmpeg,
		[
			"-copyts",
			"-i",
			file,
			"-map",
			"0:v:0",
			"-c:v",
			"copy",
			"-f",
			"framehash",
			"-hash",
			"sha256",
			"-",
		],
		signal,
		30 * 60_000,
		(chunk) => packets.append(chunk),
	);
	return { header, packets: packets.finish() };
}

export type RecordingFastExportRequest = Omit<RecordingPassthroughRequest, "hasCursorTrack"> & {
	signal: AbortSignal;
};

export async function prepareRecordingFastExport(
	request: RecordingFastExportRequest,
): Promise<RecordingFastExportPlan | null> {
	if (!canPreserveRecordingSource({ ...request, hasCursorTrack: false })) return null;
	if (request.signal.aborted) throw abortError();
	const clip = request.clips[0]!;
	const sidecar = await fs
		.stat(`${clip.screenPath}.cursor.json`)
		.then(() => true)
		.catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		});
	if (!canPreserveRecordingSource({ ...request, hasCursorTrack: sidecar })) return null;
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return null;
	const source = await fs.stat(clip.screenPath);
	if (!source.isFile()) return null;
	const original = await probeRecordingPackets(ffmpeg, clip.screenPath, request.signal);
	const media = parseRecordingSourceMetadata(original.header);
	const params = request.params!;
	if (
		!media ||
		media.width !== params.width ||
		media.height !== params.height ||
		media.codec !== (params.codec === "h265" ? "hevc" : "h264")
	)
		return null;
	const silence = !clip.hasAudio || media.audioStreamIndex === null;
	const durationS = request.sourceDurationSec;
	let verificationFps = media.fps;
	return {
		expectedBytes: source.size + Math.ceil(silence ? (durationS * 384_000) / 8 : 0) + 1024 * 1024,
		get fps() {
			return verificationFps;
		},
		durationS,
		render: async (stagingPath, signal, onProgress) => {
			const start = performance.now();
			const args = ["-v", "error", "-n", "-progress", "pipe:1", "-nostats", "-i", clip.screenPath];
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
			if (silence) args.push("-c:a", "aac", "-b:a", "384k", "-ar", "48000", "-ac", "2");
			else args.push("-c:a", "copy");
			args.push("-movflags", "+faststart", "-sn", "-dn", stagingPath);
			let pending = "";
			let frames = 0;
			await runRecordingFfmpeg(ffmpeg, args, signal, 30 * 60_000, (chunk) => {
				pending += chunk;
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const [key, value] = line.trim().split("=");
					if (key === "frame") {
						frames = Math.max(frames, Number(value) || 0);
						onProgress?.(frames);
					}
				}
			});
			if (frames <= 0) throw new Error("The source-preserving export contained no video frames.");
			const staged = await probeRecordingPackets(ffmpeg, stagingPath, signal);
			const stagedMedia = parseRecordingSourceMetadata(staged.header);
			// FFmpeg's human-readable duration is rounded to hundredths; allow
			// at most two display quanta, alongside exact packet PTS/DTS proof.
			const originalDuration = parseSourceAudioLayout(original.header).durationSec;
			const stagedDuration = parseSourceAudioLayout(staged.header).durationSec;
			if (
				!stagedMedia ||
				stagedMedia.width !== media.width ||
				stagedMedia.height !== media.height ||
				stagedMedia.codec !== media.codec ||
				stagedMedia.audioStreamIndex === null ||
				(originalDuration !== null &&
					stagedDuration !== null &&
					Math.abs(originalDuration - stagedDuration) > 0.020000001) ||
				frames !== original.packets.frames ||
				staged.packets.frames !== original.packets.frames ||
				staged.packets.digest !== original.packets.digest ||
				staged.packets.averageFps !== original.packets.averageFps
			) {
				throw new Error("Source-preserving export changed recording video packets or timestamps.");
			}
			// A last closing sample can make input r_frame_rate/tbr read 600 even
			// though ~58 frames/s were recorded. Remuxing normalizes that guess.
			// Packet/timestamp proof above establishes cadence preservation; the
			// native verifier still checks the staged stream's actual nominal FPS.
			verificationFps = stagedMedia.fps;
			const wallS = (performance.now() - start) / 1000;
			onProgress?.(frames);
			return {
				frames,
				wallS,
				fps: frames / Math.max(wallS, 0.000001),
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
				decoderPath: "packet-copy",
				compositorBackend: "bypassed-identity-scene",
			};
		},
	};
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveFfmpeg } from "../media/audioPeaks";
import { clipProvenance, type PlannedTrack } from "./sourceTimeline";

export const shortSourceId = (id: string) =>
	createHash("sha1").update(id).digest("hex").slice(0, 8);

export async function fileIdentity(file: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return { bytes: (await fs.stat(file)).size, sha256: hash.digest("hex") };
}

const streamSchema = z.object({
	index: z.number(),
	codec_name: z.string().optional(),
	codec_type: z.string().optional(),
	time_base: z.string().optional(),
	start_time: z.string().optional(),
	duration: z.string().optional(),
	r_frame_rate: z.string().optional(),
	avg_frame_rate: z.string().optional(),
	sample_rate: z.string().optional(),
	channels: z.number().optional(),
});
const probeSchema = z.object({ streams: z.array(streamSchema) });
const run = promisify(execFile);
const rate = (value: string | undefined) => {
	const [n, d] = (value ?? "0/0").split("/").map(Number);
	return d ? n / d : 0;
};

/** Stream facts for the manifest; null when the bundled ffprobe cannot read the file. */
export async function inspectFileFactsOrNull(file: string) {
	return inspectFileFacts(file).catch(() => null);
}

export async function inspectFileFacts(file: string) {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable for source provenance.");
	const ffprobe = path.join(
		path.dirname(ffmpeg),
		process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
	);
	const { stdout } = await run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", file], {
		maxBuffer: 8 * 1024 * 1024,
	});
	const streams = probeSchema.parse(JSON.parse(stdout)).streams;
	const variable = new Map<number, boolean>();
	for (const stream of streams.filter((entry) => entry.codec_type === "video")) {
		const packets = await run(
			ffprobe,
			[
				"-v",
				"error",
				"-select_streams",
				String(stream.index),
				"-show_packets",
				"-show_entries",
				"packet=pts_time",
				"-of",
				"csv=p=0",
				file,
			],
			{ maxBuffer: 64 * 1024 * 1024, timeout: 60000 },
		);
		const times = packets.stdout
			.split("\n")
			.map((line) => Number.parseFloat(line))
			.filter(Number.isFinite)
			.sort((a, b) => a - b);
		const intervals = times
			.slice(1)
			.map((time, index) => time - times[index])
			.filter((delta) => delta > 0);
		const tick = rate(stream.time_base);
		let min = Infinity;
		let max = 0;
		for (const interval of intervals) {
			min = Math.min(min, interval);
			max = Math.max(max, interval);
		}
		variable.set(stream.index, intervals.length > 1 && max - min > Math.max(0.000002, tick * 1.5));
	}
	return streams.map((stream) => ({
		index: stream.index,
		codec: stream.codec_name ?? null,
		type: stream.codec_type ?? null,
		timebase: stream.time_base ?? null,
		startTimeSec: stream.start_time === undefined ? null : Number(stream.start_time),
		durationSec: stream.duration === undefined ? null : Number(stream.duration),
		nominalFrameRate: stream.r_frame_rate ?? null,
		averageFrameRate: stream.avg_frame_rate ?? null,
		variableFrameRate: variable.get(stream.index) ?? false,
		variableFrameRateMethod: "packet-presentation-intervals",
		sampleRate: stream.sample_rate === undefined ? null : Number(stream.sample_rate),
		channels: stream.channels ?? null,
	}));
}

export function editMap(tracks: PlannedTrack[]) {
	return tracks.map((track) => {
		let at = 0;
		const pieces = track.items.flatMap((item) => {
			const from = at;
			at += item.duration;
			return item.type === "gap"
				? []
				: [{ file: item.file, ...clipProvenance(item, track.role, from).metadata }];
		});
		return { role: track.role, track: track.name, pieces };
	});
}

export function removedRanges(
	full: ReturnType<typeof editMap>,
	clean: ReturnType<typeof editMap>,
	markers: Array<{ keepIndex: number; name: string; comment: string }>,
) {
	const kept = clean.find((track) => track.role === "screen")?.pieces ?? [];
	return (full.find((track) => track.role === "screen")?.pieces ?? []).flatMap((piece) => {
		const intervals = kept
			.filter((entry) => entry.assetId === piece.assetId)
			.sort((a, b) => a.sourceStartSec - b.sourceStartSec);
		const removed = [];
		let at = piece.sourceStartSec;
		for (const entry of intervals) {
			const end = Math.min(entry.sourceStartSec, piece.sourceEndSec);
			if (end > at) {
				const marker = markers.find((m) => m.keepIndex === entry.keepIndex);
				removed.push({
					assetId: piece.assetId,
					take: piece.take,
					sourceStartSec: at,
					sourceEndSec: end,
					...(marker
						? {
								kind: marker.name,
								reason: marker.comment,
								words: [...marker.comment.matchAll(/“([^”]*)”/g)].map((match) => match[1]),
							}
						: {}),
				});
			}
			at = Math.max(at, Math.min(entry.sourceEndSec, piece.sourceEndSec));
		}
		if (at < piece.sourceEndSec)
			removed.push({
				assetId: piece.assetId,
				take: piece.take,
				sourceStartSec: at,
				sourceEndSec: piece.sourceEndSec,
			});
		return removed;
	});
}

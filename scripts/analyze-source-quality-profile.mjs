#!/usr/bin/env node
// Read-only media analysis after timed capture/export runs; originals remain untouched.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	analyzePacketCadence,
	summarizeDecodedDuplicates,
	summarizeLiveProcessSamples,
	summarizeVideoProbe,
} from "./source-quality-profile-utils.mjs";

if (process.argv.length < 3) throw new Error("Pass successful real profile report.json paths");
for (const reportPath of process.argv.slice(2)) {
	const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
	if (report.status !== "passed" || !report.sourceExport?.hashPairs?.length)
		throw new Error("Analysis requires a successful actual four-source export report");
	const out = path.dirname(path.resolve(reportPath));
	const recording = report.recordings.at(-1);
	const proof = {
		measurementSource: path.resolve(reportPath),
		fixtureSha256: report.fixtureSha256,
		quality: report.options.quality,
		captureHelper: report.actualCaptureHelper,
		configuredRequest: report.nativeCaptureHistory.find(
			(event) => event.name === "start-native-mac-recording",
		)?.request,
		telemetry: report.nativeCaptureHistory
			.filter((event) => event.name === "stop-native-mac-recording")
			.at(-1)?.result?.telemetry,
		live: summarizeLiveProcessSamples(recording.liveSamples),
		sourceExport: {
			wallMs: report.sourceExport.wallMs,
			nativeMs: report.sourceExport.nativeMs,
			media: [],
		},
	};
	for (const pair of report.sourceExport.hashPairs) {
		const probe = JSON.parse(
			execFileSync(
				"/opt/homebrew/bin/ffprobe",
				[
					"-v",
					"error",
					"-count_packets",
					"-show_format",
					"-show_streams",
					"-of",
					"json",
					pair.original,
				],
				{ encoding: "utf8", maxBuffer: 10_000_000 },
			),
		);
		const entry = { ...pair, probe };
		const video = probe.streams.find((stream) => stream.codec_type === "video");
		if (video) {
			entry.metrics = summarizeVideoProbe(probe);
			const packetProbe = JSON.parse(
				execFileSync(
					"/opt/homebrew/bin/ffprobe",
					[
						"-v",
						"error",
						"-select_streams",
						"v:0",
						"-show_streams",
						"-show_packets",
						"-show_entries",
						"packet=stream_index,pts_time,dts_time,duration_time",
						"-of",
						"json",
						pair.original,
					],
					{ encoding: "utf8", maxBuffer: 10_000_000 },
				),
			);
			const name = path.basename(pair.exported).replace(/\.[^.]+$/, "");
			fs.writeFileSync(path.join(out, `${name}-packets.json`), JSON.stringify(packetProbe));
			const nominal = String(video.r_frame_rate).split("/").map(Number);
			const sourceFps = nominal[0] / nominal[1];
			entry.packetCadence = analyzePacketCadence(
				packetProbe,
				name.includes("camera") ? sourceFps : 60,
			);
			const md5 = execFileSync(
				"/opt/homebrew/bin/ffmpeg",
				[
					"-v",
					"error",
					"-threads",
					"2",
					"-i",
					pair.original,
					"-map",
					"0:v:0",
					"-an",
					"-fps_mode",
					"passthrough",
					"-f",
					"framemd5",
					"-",
				],
				{ encoding: "utf8", maxBuffer: 10_000_000, timeout: 300_000 },
			);
			fs.writeFileSync(path.join(out, `${name}-decoded.framemd5`), md5);
			entry.decoded = summarizeDecodedDuplicates(md5);
			for (const [label, seconds] of [
				["head", 1],
				["tail", Math.max(0, entry.metrics.durationSec - 1)],
			]) {
				const image = path.join(out, `${name}-${label}.png`);
				execFileSync(
					"/opt/homebrew/bin/ffmpeg",
					[
						"-y",
						"-v",
						"error",
						"-threads",
						"2",
						"-ss",
						String(seconds),
						"-i",
						pair.original,
						"-frames:v",
						"1",
						image,
					],
					{ stdio: "pipe", timeout: 30_000 },
				);
			}
		} else {
			const audio = spawnSync(
				"/opt/homebrew/bin/ffmpeg",
				["-v", "info", "-i", pair.original, "-t", "8", "-af", "volumedetect", "-f", "null", "-"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
			);
			if (audio.error || audio.status !== 0) throw audio.error ?? new Error(audio.stderr);
			entry.audioAnalysis = audio.stderr;
		}
		proof.sourceExport.media.push(entry);
		console.log(
			JSON.stringify({ event: "source-analyzed", source: pair.original, quality: proof.quality }),
		);
	}
	fs.writeFileSync(path.join(out, "media-analysis.json"), JSON.stringify(proof, null, 2));
}

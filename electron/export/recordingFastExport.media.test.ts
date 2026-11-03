import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { SceneDescription } from "../../src/native/sceneDescription";
import { resolveFfmpeg } from "../media/audioPeaks";
import type { CompositorViewAddon } from "../native/compositor-view/addon";
import {
	parseRecordingSourceMetadata,
	prepareRecordingFastExport,
	runRecordingFfmpeg,
	sourceReadFailure,
} from "./recordingFastExport";

const ffmpeg = resolveFfmpeg();
const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function topLevelBoxes(file: string): Promise<string[]> {
	const handle = await fs.open(file, "r");
	try {
		const { size } = await handle.stat();
		const boxes: string[] = [];
		const header = Buffer.alloc(16);
		for (let offset = 0; offset < size; ) {
			await handle.read(header, 0, 16, offset);
			const short = header.readUInt32BE(0);
			const length = short === 1 ? Number(header.readBigUInt64BE(8)) : short || size - offset;
			boxes.push(header.toString("latin1", 4, 8));
			offset += length;
		}
		return boxes;
	} finally {
		await handle.close();
	}
}

function identityScene(clips: SceneDescription["clips"]): SceneDescription {
	return {
		clips,
		layout: {
			preset: "no-webcam",
			webcamSize: 0.25,
			webcamZoom: 1,
			webcamFocalPoint: { cx: 0.5, cy: 0.5 },
			screenZoom: 1,
			screenFocalPoint: { cx: 0.5, cy: 0.5 },
			webcamShape: "rectangle",
			webcamMirror: false,
			webcamPosition: null,
			webcamReactiveZoom: false,
			webcamRect: null,
			screenRect: { x: 0, y: 0, width: 1, height: 1 },
			screenCover: false,
		},
		effects: { padding: 0, blur: false, shadow: 0, roundnessFrac: 0, motionBlur: 0 },
		background: { kind: "color", color: "#000000" },
		zoomRegions: [],
		annotations: [],
		cameraFullscreenRegions: [],
		speedRegions: [],
		cursor: {
			show: true,
			size: 1,
			smoothing: 0,
			motionBlur: 0,
			clickBounce: 0,
			clipToBounds: false,
			theme: "default",
		},
		cropByClip: [null, null, null],
		output: { width: 160, height: 90, fps: 60 },
	};
}

describe("real source-preserving media export", () => {
	it
		.runIf(process.platform === "darwin" && !!ffmpeg)
		.each(["silent", "mixed", "vfr", "closing"] as const)(
		"preserves encoded packets and decoded frames for a %s recording",
		async (audio) => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-recording-copy-"));
			temporary.push(directory);
			const sourcePath = path.join(directory, "source.mp4");
			const outputPath = path.join(directory, "output.mp4");
			const signal = new AbortController().signal;
			const sourceFps = audio === "vfr" ? 58 : 60;
			const args = [
				"-v",
				"error",
				"-n",
				"-f",
				"lavfi",
				"-i",
				`testsrc2=size=160x90:rate=${sourceFps}`,
			];
			if (audio === "mixed") {
				for (const frequency of [440, 220, 660])
					args.push("-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`);
			}
			args.push("-map", "0:v:0");
			if (audio === "vfr") args.push("-vf", "select='not(eq(mod(n+1,29),0))'", "-fps_mode", "vfr");
			if (audio === "mixed")
				args.push(
					"-map",
					"1:a:0",
					"-map",
					"2:a:0",
					"-map",
					"3:a:0",
					"-c:a",
					"aac",
					"-ar",
					"48000",
					"-ac",
					"2",
					"-metadata:s:a:0",
					"language=qaa",
					"-metadata:s:a:1",
					"language=qab",
					"-metadata:s:a:2",
					"language=qac",
				);
			args.push(
				"-t",
				"2",
				"-c:v",
				"h264_videotoolbox",
				"-b:v",
				"1000k",
				"-pix_fmt",
				"yuv420p",
				sourcePath,
			);
			if (audio === "closing")
				await promisify(execFile)(
					"/usr/bin/swift",
					[path.resolve("electron/export/fixtures/closing-frame.swift"), sourcePath],
					{ timeout: 30_000 },
				);
			else await runRecordingFfmpeg(ffmpeg!, args, signal, 20_000);
			const addon = createRequire(import.meta.url)(
				path.resolve("electron/native/bin/darwin-arm64/compositor_view.node"),
			) as CompositorViewAddon;
			const sourceDuration = await addon.probeMediaDuration!(sourcePath);
			const sourceHeader = await runRecordingFfmpeg(
				ffmpeg!,
				["-i", sourcePath, "-map", "0:a?", "-t", "0", "-c", "copy", "-f", "null", "-"],
				signal,
				10_000,
			);
			const sourceMetadata = parseRecordingSourceMetadata(sourceHeader)!;
			const clip = {
				screenPath: sourcePath,
				webcamPath: "",
				sourceStartSec: 0,
				sourceEndSec: sourceDuration,
				webcamOffsetSec: 0,
				hasAudio: true,
			};
			const scene: SceneDescription = {
				clips: [clip],
				layout: {
					preset: "no-webcam",
					webcamSize: 0.25,
					webcamZoom: 1,
					webcamFocalPoint: { cx: 0.5, cy: 0.5 },
					screenZoom: 1,
					screenFocalPoint: { cx: 0.5, cy: 0.5 },
					webcamShape: "rectangle",
					webcamMirror: false,
					webcamPosition: null,
					webcamReactiveZoom: false,
					webcamRect: null,
					screenRect: { x: 0, y: 0, width: 1, height: 1 },
					screenCover: false,
				},
				effects: { padding: 0, blur: false, shadow: 0, roundnessFrac: 0, motionBlur: 0 },
				background: { kind: "color", color: "#000000" },
				zoomRegions: [],
				annotations: [],
				cameraFullscreenRegions: [],
				speedRegions: [],
				cursor: {
					show: true,
					size: 1,
					smoothing: 0,
					motionBlur: 0,
					clickBounce: 0,
					clipToBounds: false,
					theme: "default",
				},
				cropByClip: [null],
				output: { width: 160, height: 90, fps: 60 },
			};
			const progress: number[] = [];
			const plan = await prepareRecordingFastExport({
				clips: [clip],
				sceneJson: JSON.stringify(scene),
				sourceDurationsSec: [sourceDuration],
				params: {
					width: 160,
					height: 90,
					fps: 60,
					codec: "h264",
					preserveRecordingSource: true,
					normalizeAudio: false,
					evenVolume: false,
				},
				signal,
				onProgress: (frames) => progress.push(frames),
			});
			expect(plan).not.toBeNull();
			expect(plan!.fps).toBe(sourceMetadata.fps);
			const result = await plan!.render(outputPath, signal, (frames) => progress.push(frames));
			// One bar across read, copy and read-back, on the rendered export's frame scale.
			const total = Math.round(sourceDuration * 60);
			expect(progress.at(-1)).toBe(total);
			expect((await topLevelBoxes(outputPath)).filter((box) => box !== "free")).toEqual([
				"ftyp",
				"moov",
				"mdat",
			]);
			expect(progress.every((frames, i) => i === 0 || frames > progress[i - 1]!)).toBe(true);
			expect(progress.every((frames) => frames <= total)).toBe(true);
			expect(result).toMatchObject({
				frames: audio === "vfr" ? 112 : audio === "closing" ? 121 : 120,
				encoderName: "stream-copy/h264",
				decoderPath: "packet-copy",
				audioMastering: { enabled: false },
			});
			const inspect = async (file: string) =>
				await runRecordingFfmpeg(
					ffmpeg!,
					["-i", file, "-map", "0:a?", "-t", "0", "-c", "copy", "-f", "null", "-"],
					signal,
					10_000,
				);
			expect(parseRecordingSourceMetadata(await inspect(outputPath))).toMatchObject({
				width: 160,
				height: 90,
				fps: plan!.fps,
				audioStreamIndex: 1,
			});
			if (audio === "closing") {
				expect(sourceMetadata.fps).toBe(600);
				expect(plan!.fps).not.toBe(600);
				await expect(
					addon.verifyVideoExport!(outputPath, {
						width: 160,
						height: 90,
						fps: sourceMetadata.fps,
						durationS: sourceDuration,
						codec: "h264",
					}),
				).rejects.toThrow("frame rate");
			}
			await addon.verifyVideoExport!(outputPath, {
				width: 160,
				height: 90,
				fps: plan!.fps,
				durationS: sourceDuration,
				codec: "h264",
			});
			const hash = async (file: string, map: string, decoded: boolean) => {
				let stdout = "";
				await runRecordingFfmpeg(
					ffmpeg!,
					[
						"-v",
						"error",
						// A zero-duration native closing packet is marked discard by
						// its original MP4 edit list. Compare all encoded frames.
						...(decoded ? ["-ignore_editlist", "1"] : []),
						"-i",
						file,
						"-map",
						map,
						...(decoded
							? ["-fps_mode", "passthrough", "-f", "framemd5"]
							: ["-c", "copy", "-f", "hash", "-hash", "sha256"]),
						"-",
					],
					signal,
					10_000,
					(chunk) => {
						stdout += chunk;
					},
				);
				return decoded
					? stdout
							.split("\n")
							.filter((line) => line && !line.startsWith("#"))
							.map((line) => line.split(",").at(-1)!.trim())
					: stdout.trim();
			};
			expect(await hash(outputPath, "0:v:0", false)).toBe(await hash(sourcePath, "0:v:0", false));
			expect(await hash(outputPath, "0:v:0", true)).toEqual(await hash(sourcePath, "0:v:0", true));
			if (audio === "mixed")
				expect(await hash(outputPath, "0:a:0", false)).toBe(
					await hash(sourcePath, "0:m:language:qaa", false),
				);
		},
		30_000,
	);
});

import { execFile } from "node:child_process";

describe("real joined-takes media export", () => {
	it.runIf(process.platform === "darwin" && !!ffmpeg)(
		"joins takes split by Pause with unchanged packets and audio that stays in sync",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-recording-join-"));
			temporary.push(directory);
			const signal = new AbortController().signal;
			const takes = [1.3, 2.6, 0.7].map((seconds, index) => ({
				seconds,
				path: path.join(directory, `take ${index + 1} it's.mp4`),
			}));
			for (const [index, take] of takes.entries()) {
				const args = ["-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=60"];
				for (const frequency of [440 + index * 110, 220, 660])
					args.push("-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`);
				args.push("-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0", "-map", "3:a:0");
				args.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
				for (const [track, language] of ["qaa", "qab", "qac"].entries())
					args.push(`-metadata:s:a:${track}`, `language=${language}`);
				args.push("-t", String(take.seconds), "-c:v", "h264_videotoolbox", "-b:v", "1000k");
				args.push("-pix_fmt", "yuv420p", take.path);
				await runRecordingFfmpeg(ffmpeg!, args, signal, 20_000);
			}
			const addon = createRequire(import.meta.url)(
				path.resolve("electron/native/bin/darwin-arm64/compositor_view.node"),
			) as CompositorViewAddon;
			const durations = await Promise.all(
				takes.map((take) => addon.probeMediaDuration!(take.path)),
			);
			const clips = takes.map((take, index) => ({
				screenPath: take.path,
				webcamPath: "",
				sourceStartSec: 0,
				sourceEndSec: durations[index]!,
				webcamOffsetSec: 0,
				hasAudio: true,
			}));
			const scene = identityScene(clips);
			const plan = await prepareRecordingFastExport({
				clips,
				sceneJson: JSON.stringify(scene),
				sourceDurationsSec: durations,
				params: {
					width: 160,
					height: 90,
					fps: 60,
					codec: "h264",
					preserveRecordingSource: true,
					normalizeAudio: false,
					evenVolume: false,
				},
				signal,
			});
			expect(plan).not.toBeNull();
			const total = durations.reduce((sum, duration) => sum + duration, 0);
			expect(plan!.durationS).toBeCloseTo(total, 6);
			const outputPath = path.join(directory, "joined.mp4");
			const progress: number[] = [];
			const result = await plan!.render(outputPath, signal, (frames) => progress.push(frames));
			expect(progress.at(-1)).toBe(Math.round(total * 60));
			expect(result).toMatchObject({
				decoderPath: "packet-concat",
				encoderName: "stream-copy/h264",
			});
			expect((await topLevelBoxes(outputPath)).filter((box) => box !== "free")).toEqual([
				"ftyp",
				"moov",
				"mdat",
			]);
			const packets = async (file: string) => {
				let stdout = "";
				await runRecordingFfmpeg(
					ffmpeg!,
					["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framehash", "-"],
					signal,
					10_000,
					(chunk) => {
						stdout += chunk;
					},
				);
				return stdout
					.split("\n")
					.filter((line) => line && !line.startsWith("#"))
					.map((line) => line.split(",").slice(4).join(",").trim());
			};
			const sourcePackets = (await Promise.all(takes.map((take) => packets(take.path)))).flat();
			expect(await packets(outputPath)).toEqual(sourcePackets);
			const streamDuration = async (map: string) => {
				let stdout = "";
				await runRecordingFfmpeg(
					ffmpeg!,
					["-v", "error", "-i", outputPath, "-map", map, "-f", "framecrc", "-"],
					signal,
					10_000,
					(chunk) => {
						stdout += chunk;
					},
				);
				const last = stdout
					.trim()
					.split("\n")
					.at(-1)!
					.split(",")
					.map((field) => field.trim());
				const tb = /#tb \d+: (\d+)\/(\d+)/.exec(stdout)!;
				return ((Number(last[2]) + Number(last[3])) * Number(tb[1])) / Number(tb[2]);
			};
			// Audio ends with the joined video, not 21-43 ms early or late per join.
			expect(Math.abs((await streamDuration("0:a:0")) - total)).toBeLessThan(0.03);
			await addon.verifyVideoExport!(outputPath, {
				width: 160,
				height: 90,
				fps: plan!.fps,
				durationS: plan!.durationS,
				codec: "h264",
			});
		},
		60_000,
	);
});

describe("a take cut short on disk", () => {
	it("recognises a failed source read in FFmpeg's log", () => {
		expect(sourceReadFailure("[mov @ 0x1] stream 0, offset 0x13a: partial file\n")).toContain(
			"partial file",
		);
		expect(sourceReadFailure("[h264 @ 0x1] Reinit context to 160x96\n")).toBeNull();
	});

	const signal = new AbortController().signal;

	async function h264Encoder(): Promise<string | null> {
		let encoders = "";
		await runRecordingFfmpeg(ffmpeg!, ["-v", "quiet", "-encoders"], signal, 20_000, (chunk) => {
			encoders += chunk;
		});
		return (
			["libx264", "libopenh264", "h264_videotoolbox"].find((name) => encoders.includes(name)) ??
			null
		);
	}

	async function exportTakes(directory: string, cutFirstTake: boolean, movflags = "+faststart") {
		const encoder = await h264Encoder();
		if (!encoder) throw new Error("This FFmpeg has no H.264 encoder.");
		const takes = [0, 1].map((index) => path.join(directory, `take-${index}.mp4`));
		for (const [index, take] of takes.entries()) {
			await runRecordingFfmpeg(
				ffmpeg!,
				[
					"-v",
					"error",
					"-n",
					"-f",
					"lavfi",
					"-i",
					"testsrc2=size=160x90:rate=24",
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=${440 + index * 220}:sample_rate=48000`,
					"-t",
					"5",
					"-c:v",
					encoder,
					"-g",
					"12",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-ar",
					"48000",
					"-ac",
					"2",
					"-movflags",
					movflags,
					take,
				],
				signal,
				60_000,
			);
		}
		if (cutFirstTake) {
			const { size } = await fs.stat(takes[0]!);
			await fs.truncate(takes[0]!, Math.floor(size / 2));
		}
		const clips = takes.map((screenPath) => ({
			screenPath,
			webcamPath: "",
			sourceStartSec: 0,
			sourceEndSec: 5,
			webcamOffsetSec: 0,
			hasAudio: true,
		}));
		const scene = identityScene(clips);
		scene.output = { width: 160, height: 90, fps: 24 };
		scene.cropByClip = [null, null];
		const plan = await prepareRecordingFastExport({
			clips,
			sceneJson: JSON.stringify(scene),
			sourceDurationsSec: [5, 5],
			params: {
				width: 160,
				height: 90,
				fps: 24,
				codec: "h264",
				preserveRecordingSource: true,
				normalizeAudio: false,
				evenVolume: false,
			},
			signal,
		});
		expect(plan).not.toBeNull();
		return await plan!.render(path.join(directory, "joined.mp4"), signal, () => undefined);
	}

	it.runIf(!!ffmpeg)(
		"refuses to pass a joined export with frames missing from one take",
		async () => {
			const whole = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-take-whole-"));
			temporary.push(whole);
			expect((await exportTakes(whole, false)).frames).toBe(240);
			const cut = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-take-cut-"));
			temporary.push(cut);
			await expect(exportTakes(cut, true)).rejects.toThrow(/recording source is incomplete/);
		},
		120_000,
	);

	it.runIf(!!ffmpeg)(
		"still exports a take that a crash cut inside its last fragment",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-take-crash-"));
			temporary.push(directory);
			const result = await exportTakes(
				directory,
				true,
				"frag_keyframe+empty_moov+default_base_moof",
			);
			expect(result.frames).toBeGreaterThan(150);
			expect(result.frames).toBeLessThan(240);
		},
		120_000,
	);
});

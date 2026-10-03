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
} from "./recordingFastExport";

const ffmpeg = resolveFfmpeg();
const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

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
			const plan = await prepareRecordingFastExport({
				clips: [clip],
				sceneJson: JSON.stringify(scene),
				sourceDurationSec: sourceDuration,
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
			expect(plan!.fps).toBe(sourceMetadata.fps);
			const result = await plan!.render(outputPath, signal);
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

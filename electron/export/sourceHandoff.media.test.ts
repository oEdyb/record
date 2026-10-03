// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { resolveFfmpeg } from "../media/audioPeaks";
import { inspectSourceAudioLayout } from "../stt/sourceAudio";
import { exportSourceHandoff } from "./sourceHandoff";

const ffmpeg = resolveFfmpeg();
it.runIf(process.platform === "darwin" && ffmpeg !== null)(
	"byte-copies complete original containers and standalone audio while OTIO preserves cuts and audio delay",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-source-media-"));
		try {
			const source = path.join(root, "offset.mkv");
			const generated = spawnSync(
				ffmpeg!,
				[
					"-hide_banner",
					"-nostdin",
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"color=c=black:s=160x90:r=30:d=1",
					"-itsoffset",
					"0.2",
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=440:duration=0.8",
					"-map",
					"0:v",
					"-map",
					"1:a",
					"-c:v",
					"h264_videotoolbox",
					"-b:v",
					"1M",
					"-c:a",
					"pcm_s16le",
					"-metadata:s:a:0",
					"language=qac",
					"-output_ts_offset",
					"5",
					source,
				],
				{ timeout: 15_000 },
			);
			expect(generated.status, generated.stderr.toString()).toBe(0);
			const microphone = path.join(root, "microphone.m4a");
			const system = path.join(root, "system.m4a");
			const camera = path.join(root, "camera.mov");
			for (const [filename, frequency, duration] of [
				[microphone, "440", "0.8"],
				[system, "880", "0.9"],
			]) {
				const audio = spawnSync(
					ffmpeg!,
					[
						"-hide_banner",
						"-nostdin",
						"-v",
						"error",
						"-f",
						"lavfi",
						"-i",
						`sine=frequency=${frequency}:duration=${duration}`,
						"-c:a",
						"aac",
						filename,
					],
					{ timeout: 15_000 },
				);
				expect(audio.status, audio.stderr.toString()).toBe(0);
			}
			const cameraGenerated = spawnSync(
				ffmpeg!,
				[
					"-hide_banner",
					"-nostdin",
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"color=c=red:s=160x90:r=30:d=1",
					"-c:v",
					"h264_videotoolbox",
					"-b:v",
					"1M",
					camera,
				],
				{ timeout: 15_000 },
			);
			expect(cameraGenerated.status, cameraGenerated.stderr.toString()).toBe(0);
			const doc = createEmptyDocument({ title: "Offset", projectId: "offset" });
			doc.assets = [
				{
					id: "a",
					kind: "video",
					label: "Offset",
					originalPath: source,
					cameraTrack: { sourcePath: camera, startMs: 0, offsetMs: 0, visible: false },
					microphoneAudioPath: microphone,
					systemAudioPath: system,
					microphoneAudioOffsetMs: 200,
					systemAudioOffsetMs: 100,
				},
			];
			doc.timeline.clips = [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "Test",
				},
			];
			doc.timeline.trimRanges = [
				{
					id: "cut",
					assetId: "a",
					clipId: "c",
					startSec: 0.6,
					endSec: 0.7,
					origin: "user",
					reason: "Keep originals complete",
				},
			];
			const result = await exportSourceHandoff(doc, root, (file) => file);
			const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
			expect(manifest.sources[0].screen.file).toBe("001-screen.mkv");
			expect((await inspectSourceAudioLayout(source)).durationSec).toBe(6);
			expect(manifest.sources[0].screen.durationSec).toBeCloseTo(1, 6);
			expect(manifest).not.toHaveProperty("clips");
			expect(manifest.sources[0].screen.audio).toMatchObject([
				{ role: "microphone", file: "001-microphone.m4a" },
				{ role: "system", file: "001-system.m4a" },
			]);
			expect(result.sourceCount).toBe(4);
			for (const [original, name] of [
				[source, "001-screen.mkv"],
				[camera, "001-camera.mov"],
				[microphone, "001-microphone.m4a"],
				[system, "001-system.m4a"],
			]) {
				expect(await fs.readFile(path.join(result.directory, name))).toEqual(
					await fs.readFile(original),
				);
			}
			const timeline = JSON.parse(await fs.readFile(result.timelinePath, "utf8"));
			expect(timeline.tracks.children).toHaveLength(4);
			const screenClips = timeline.tracks.children[0].children;
			expect(screenClips).toHaveLength(2);
			expect(screenClips[0]).toMatchObject({
				source_range: { start_time: { value: 0 }, duration: { value: 36 } },
				media_references: {
					DEFAULT_MEDIA: { available_range: { duration: { value: 60 } } },
				},
				metadata: { klippt: { sourceStartSec: 0, sourceEndSec: 0.6 } },
			});
			expect(screenClips[1]).toMatchObject({
				source_range: { start_time: { value: 42 }, duration: { value: 18 } },
				metadata: {
					klippt: { sourceStartSec: 0.7, sourceEndSec: 1, timelineEndSec: 0.9 },
				},
			});
			expect(timeline.tracks.children[2].children[0]).toMatchObject({
				OTIO_SCHEMA: "Gap.1",
				source_range: { duration: { value: 12 } },
			});
			expect(timeline.tracks.children[2].children[1].name).toBe("001-microphone.m4a");
			expect(timeline.tracks.children[2].children[2].source_range.start_time.value).toBe(30);
			expect(timeline.tracks.children[3].children[0]).toMatchObject({
				OTIO_SCHEMA: "Gap.1",
				source_range: { duration: { value: 6 } },
			});
			expect(
				(await inspectSourceAudioLayout(path.join(result.directory, "001-microphone.m4a")))
					.durationSec,
			).toBeCloseTo(0.8, 1);
			const pcm = spawnSync(
				ffmpeg!,
				[
					"-hide_banner",
					"-v",
					"error",
					"-i",
					path.join(result.directory, "001-microphone.m4a"),
					"-f",
					"s16le",
					"-ac",
					"1",
					"-ar",
					"48000",
					"-",
				],
				{ maxBuffer: 1024 * 1024 },
			);
			expect(pcm.status, pcm.stderr.toString()).toBe(0);
			expect(pcm.stdout.subarray(0, 48000 * 0.15 * 2).some((byte) => byte !== 0)).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);

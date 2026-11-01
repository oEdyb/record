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
			expect(manifest.files).toHaveLength(4);
			expect(manifest.files[0]).toMatchObject({
				bytes: (await fs.stat(source)).size,
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				streams: expect.arrayContaining([
					expect.objectContaining({
						type: "video",
						codec: "h264",
						timebase: expect.any(String),
						nominalFrameRate: expect.any(String),
						averageFrameRate: expect.any(String),
						variableFrameRate: expect.any(Boolean),
					}),
				]),
			});
			expect(manifest.sources[0].screen.file).toBe("001-86f7e437-screen.mkv");
			expect((await inspectSourceAudioLayout(source)).durationSec).toBe(6);
			expect(manifest.sources[0].screen.durationSec).toBeCloseTo(1, 6);
			expect(manifest).not.toHaveProperty("clips");
			expect(manifest.sources[0].screen.audio).toMatchObject([
				{ role: "microphone", file: "001-86f7e437-microphone.m4a" },
				{ role: "system", file: "001-86f7e437-system.m4a" },
			]);
			expect(result.sourceCount).toBe(4);
			for (const [original, name] of [
				[source, "001-86f7e437-screen.mkv"],
				[camera, "001-86f7e437-camera.mov"],
				[microphone, "001-86f7e437-microphone.m4a"],
				[system, "001-86f7e437-system.m4a"],
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
			expect(timeline.tracks.children[2].children[1].name).toBe("T001 microphone 0.00–0.40s");
			expect(timeline.tracks.children[2].children[2].source_range.start_time.value).toBe(30);
			expect(timeline.tracks.children[3].children[0]).toMatchObject({
				OTIO_SCHEMA: "Gap.1",
				source_range: { duration: { value: 6 } },
			});
			expect(
				(await inspectSourceAudioLayout(path.join(result.directory, "001-86f7e437-microphone.m4a")))
					.durationSec,
			).toBeCloseTo(0.8, 1);
			const pcm = spawnSync(
				ffmpeg!,
				[
					"-hide_banner",
					"-v",
					"error",
					"-i",
					path.join(result.directory, "001-86f7e437-microphone.m4a"),
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

it.runIf(ffmpeg !== null)(
	"exports a real Clean dialogue WAV with clean-only replacement and exact timeline duration",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-clean-handoff-"));
		try {
			const screen = path.join(root, "screen.mp4");
			const mic = path.join(root, "microphone.wav");
			for (const args of [
				["-f", "lavfi", "-i", "color=c=black:s=160x90:r=60:d=2", "-c:v", "mpeg4", screen],
				[
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=440:sample_rate=48000:duration=2",
					"-c:a",
					"pcm_s24le",
					mic,
				],
			]) {
				const result = spawnSync(ffmpeg!, ["-v", "error", ...args]);
				expect(result.status, result.stderr.toString()).toBe(0);
			}
			const doc = createEmptyDocument({ title: "Clean", projectId: "clean" });
			doc.assets = [
				{
					id: "a",
					kind: "video",
					label: "Screen",
					originalPath: screen,
					cameraTrack: null,
					microphoneAudioPath: mic,
					microphoneAudioOffsetMs: 100,
				},
			];
			doc.timeline.clips = [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 2,
					timelineStartSec: 0,
					timelineEndSec: 2,
					wordRefs: [],
					origin: "user",
					reason: "Test",
				},
			];
			const result = await exportSourceHandoff(doc, root, (file) => file, {
				keep: [
					{ assetId: "a", startSec: 0, endSec: 0.5 },
					{ assetId: "a", startSec: 1, endSec: 1.5 },
				],
				markers: [],
			});
			const clean = JSON.parse(await fs.readFile(result.cleanCutPath!, "utf8"));
			const full = JSON.parse(await fs.readFile(result.timelinePath, "utf8"));
			const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
			expect(
				manifest.files.find((file: { file: string }) => file.file === manifest.cleanDialogue.file),
			).toMatchObject({
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				streams: [expect.objectContaining({ codec: "pcm_s24le", sampleRate: 48000 })],
			});
			expect(manifest.activeDialogue).toMatchObject({
				file: manifest.cleanDialogue.file,
				track: "Clean dialogue",
				offsetSec: 0,
			});
			expect(manifest.cleanDialogue).toMatchObject({
				file: expect.stringMatching(/^000-[a-f0-9]{8}-clean-dialogue\.wav$/),
				samples: 48000,
				channels: 1,
			});
			expect(clean.tracks.children.at(-1)).toMatchObject({
				name: "Clean dialogue",
				children: [{ source_range: { start_time: { value: 0 }, duration: { value: 60 } } }],
			});
			expect(
				clean.tracks.children[2].children
					.filter((child: { OTIO_SCHEMA: string }) => child.OTIO_SCHEMA === "Clip.2")
					.every((child: { enabled: boolean }) => child.enabled === false),
			).toBe(true);
			expect(JSON.stringify(full)).not.toContain('"enabled":false');
			expect(full.tracks.children).toHaveLength(4);
			const wav = await fs.readFile(path.join(result.directory, manifest.cleanDialogue.file));
			expect(wav.length).toBe(44 + 48000 * 3);
			const ffprobe = spawnSync("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=noprint_wrappers=1:nokey=1",
				path.join(result.directory, manifest.cleanDialogue.file),
			]);
			if (!ffprobe.error) {
				expect(ffprobe.status).toBe(0);
				expect(Number(ffprobe.stdout.toString().trim())).toBe(1);
			}
			expect(wav.subarray(44, 44 + 4800 * 3).every((byte) => byte === 0)).toBe(true);
			expect(await fs.readFile(mic)).toEqual(
				await fs.readFile(path.join(result.directory, "001-86f7e437-microphone.wav")),
			);
			const probe = spawnSync(ffmpeg!, [
				"-hide_banner",
				"-i",
				path.join(result.directory, manifest.cleanDialogue.file),
				"-f",
				"null",
				"-",
			]);
			expect(probe.status).toBe(0);
			expect(probe.stderr.toString()).toContain("Duration: 00:00:01.00");
			expect(await fs.readFile(path.join(result.directory, "README.txt"), "utf8")).toContain(
				"derived 48 kHz, 24-bit",
			);
			await expect(
				fs.access(path.join(result.directory, "timeline-clean-cut.fcpxml")),
			).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);

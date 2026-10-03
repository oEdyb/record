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
	"keeps video, delayed mic, and manifest aligned when remuxing a nonzero timestamp origin",
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
			const doc = createEmptyDocument({ title: "Offset", projectId: "offset" });
			doc.assets = [
				{ id: "a", kind: "video", label: "Offset", originalPath: source, cameraTrack: null },
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
			const result = await exportSourceHandoff(doc, root, (file) => file);
			const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
			expect(manifest.sources[0].screen.file).toBe("001-screen.mov");
			expect(manifest.sources[0].screen.durationSec).toBeCloseTo(1, 1);
			expect(manifest.clips[0].sourceEndSec).toBeCloseTo(1, 1);
			expect(manifest.sources[0].screen.audio).toMatchObject([
				{ role: "microphone", file: "001-microphone.wav" },
			]);
			const wav = path.join(result.directory, "001-microphone.wav");
			expect(manifest.sources[0].screen.audio[0].durationSec).toBeCloseTo(1, 1);
			const timeline = JSON.parse(await fs.readFile(result.timelinePath, "utf8"));
			expect(timeline.tracks.children[2].children[0].name).toBe("001-microphone.wav");
			expect((await inspectSourceAudioLayout(wav)).durationSec).toBeCloseTo(1, 1);
			const pcm = spawnSync(
				ffmpeg!,
				["-hide_banner", "-v", "error", "-i", wav, "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
				{ maxBuffer: 1024 * 1024 },
			);
			expect(pcm.status, pcm.stderr.toString()).toBe(0);
			expect(pcm.stdout.subarray(0, 48000 * 0.15 * 2).every((byte) => byte === 0)).toBe(true);
			expect(pcm.stdout.subarray(48000 * 0.25 * 2).some((byte) => byte !== 0)).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);

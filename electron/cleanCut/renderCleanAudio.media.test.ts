// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { PlannedItem } from "../export/sourceTimeline";
import { resolveFfmpeg } from "../media/audioPeaks";
import { renderCleanAudio } from "./renderCleanAudio";

const ffmpeg = resolveFfmpeg();
function item(start: number, duration: number): PlannedItem {
	return {
		type: "clip",
		file: "mic.wav",
		start,
		duration,
		available: 120,
		offsetSec: 0,
		span: {
			id: "c",
			assetId: "a",
			sourceStartSec: start / 60,
			timelineStartSec: 0,
			timelineEndSec: duration / 60,
		},
	};
}

it.runIf(ffmpeg !== null)(
	"renders stereo 24-bit PCM with exact duration, unchanged samples outside blends and no clipping",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "clean-dialogue-media-"));
		try {
			const generated = spawnSync(ffmpeg!, [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"aevalsrc=0.8+0.1*sin(2*PI*5*t)|0.7+0.1*cos(2*PI*5*t):s=48000:d=2",
				"-c:a",
				"pcm_s24le",
				path.join(root, "mic.wav"),
			]);
			expect(generated.status, generated.stderr.toString()).toBe(0);
			const output = path.join(root, "clean.wav");
			const result = await renderCleanAudio({
				directory: root,
				output,
				items: [item(0, 30), item(60, 30)],
				retained: [item(0, 120)],
			});
			const bytes = await fs.readFile(output);
			expect(result.samples).toBe(60 * 800);
			expect(result.channels).toBe(2);
			expect(bytes.length).toBe(44 + 48000 * 6);
			expect(bytes.readUInt16LE(34)).toBe(24);
			expect(result.attenuatedSeams).toBe(1);
			expect(result.peak).toBeLessThanOrEqual(1);
			const source = spawnSync(ffmpeg!, [
				"-v",
				"error",
				"-i",
				path.join(root, "mic.wav"),
				"-f",
				"s24le",
				"-",
			]).stdout;
			const seam = result.plan.seams[0];
			const lo = seam.outSample - Math.floor(seam.fadeSamples / 2);
			const hi = lo + seam.fadeSamples;
			// Samples outside blends retain the original 24-bit PCM exactly.
			for (let i = 0; i < 48000; i++) {
				if (i >= lo && i < hi) continue;
				const sourceSample = i < 24000 ? i : i + 24000;
				for (let c = 0; c < 2; c++)
					expect(
						Math.abs(
							bytes.readIntLE(44 + i * 6 + c * 3, 3) -
								source.readIntLE(sourceSample * 6 + c * 3, 3),
						),
					).toBe(0);
			}
			const probe = spawnSync(ffmpeg!, ["-hide_banner", "-i", output, "-f", "null", "-"]);
			expect(probe.status).toBe(0);
			expect(probe.stderr.toString()).toContain("Duration: 00:00:01.00");
			const controller = new AbortController();
			controller.abort();
			await expect(
				renderCleanAudio({
					directory: root,
					output: path.join(root, "aborted.wav"),
					items: [item(0, 60)],
					retained: [item(0, 120)],
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ name: "AbortError" });
			await expect(fs.access(path.join(root, "aborted.wav"))).rejects.toThrow();
			const running = new AbortController();
			const timer = setTimeout(() => running.abort(), 0);
			try {
				await expect(
					renderCleanAudio({
						directory: root,
						output: path.join(root, "interrupted.wav"),
						items: [item(0, 60)],
						retained: [item(0, 120)],
						signal: running.signal,
					}),
				).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				clearTimeout(timer);
			}
			await expect(fs.access(path.join(root, "interrupted.wav"))).rejects.toThrow();
			expect((await fs.readdir(root)).some((name) => name.startsWith(".clean-dialogue-"))).toBe(
				false,
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);

it.runIf(ffmpeg !== null)("hard edges never render handles from removed media", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "clean-dialogue-edge-"));
	try {
		const generated = spawnSync(ffmpeg!, [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"aevalsrc=if(between(t\\,0.5\\,1)\\,0.9\\,0):s=48000:d=2",
			"-c:a",
			"pcm_s24le",
			path.join(root, "mic.wav"),
		]);
		expect(generated.status, generated.stderr.toString()).toBe(0);
		const items = [item(0, 30), item(60, 30)];
		const output = path.join(root, "clean.wav");
		const result = await renderCleanAudio({ directory: root, output, items, retained: items });
		expect(result.plan.seams[0].mode).toBe("hard-edge");
		const wav = await fs.readFile(output);
		expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParakeetProcess, resolveParakeetBinaryPath } from "./parakeetProcess";

/**
 * Opt-in parity check of the Swift forced aligner against the Python reference
 * (~/dev/retake-cutter, torchaudio forced_align). Skipped unless CLEAN_CUT_PARITY=1:
 *
 *   CLEAN_CUT_PARITY=1 npx vitest --run electron/transcript/parakeetAlign.parity.test.ts
 *
 * Needs the built helper, both Core ML model folders and the retake-cutter cache for the source
 * file (CLEAN_CUT_PARITY_MEDIA and CLEAN_CUT_PARITY_ALIGNER override the recording and the aligner folder). The target is median <= 10 ms and
 * p90 <= 30 ms against the Python aligned times, on words both aligned.
 */
const MEDIA = process.env.CLEAN_CUT_PARITY_MEDIA ?? "/Users/olle/Downloads/2026-03-15 20-13-53.mp4";
const CACHE = path.join(homedir(), ".cache", "retake-cutter");
const MODELS = path.join(homedir(), "Library", "Application Support", "Klippt", "stt-models");
const FFMPEG = path.join(process.cwd(), "electron", "native", "bin", "darwin-arm64", "ffmpeg");

interface CachedWord {
	w: string;
	s: number;
	e: number;
}
interface ReferenceWord extends CachedWord {
	aligned: boolean;
}

/** retake-cutter transcribe._cache_key */
function cacheKey(file: string): string {
	const stat = statSync(file, { bigint: true });
	return createHash("sha1")
		.update(`${realpathSync(file)}|${stat.size}|${stat.mtimeNs}`)
		.digest("hex")
		.slice(0, 16);
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

function summary(diffs: number[]) {
	const sorted = [...diffs].sort((a, b) => a - b);
	return {
		median: quantile(sorted, 0.5),
		p90: quantile(sorted, 0.9),
		max: sorted.at(-1) ?? Number.NaN,
	};
}

const enabled = process.env.CLEAN_CUT_PARITY === "1";

describe.skipIf(!enabled)("forced alignment parity with the Python reference", () => {
	it("matches retake-cutter's aligned word times", { timeout: 30 * 60_000 }, async () => {
		const key = cacheKey(MEDIA);
		const parakeet: CachedWord[] = JSON.parse(
			readFileSync(path.join(CACHE, `${key}.json`), "utf8"),
		);
		const reference: ReferenceWord[] = JSON.parse(
			readFileSync(path.join(CACHE, `${key}-aligned-v1.json`), "utf8"),
		);
		expect(reference).toHaveLength(parakeet.length);

		const binaryPath = process.env.KLIPPT_PARAKEET_STT_EXE ?? resolveParakeetBinaryPath();
		expect(binaryPath, "built klippt-parakeet-stt helper").toBeTruthy();
		const alignerModels =
			process.env.CLEAN_CUT_PARITY_ALIGNER ?? path.join(MODELS, "wav2vec2-base-960h-coreml");
		expect(existsSync(alignerModels)).toBe(true);

		const dir = mkdtempSync(path.join(tmpdir(), "klippt-align-parity-"));
		const wav = path.join(dir, "audio.wav");
		const helper = new ParakeetProcess({
			binaryPath: binaryPath as string,
			modelDir: path.join(MODELS, "parakeet-tdt-0.6b-v3"),
		});
		try {
			execFileSync(
				FFMPEG,
				[
					"-loglevel",
					"error",
					"-y",
					"-i",
					MEDIA,
					"-vn",
					"-ac",
					"1",
					"-ar",
					"16000",
					"-c:a",
					"pcm_f32le",
					wav,
				],
				{ stdio: "inherit" },
			);
			await helper.start();
			const startedAt = performance.now();
			const result = await helper.align({
				id: "parity",
				audioPath: wav,
				alignerModels,
				words: parakeet.map((word) => ({ word: word.w, startSec: word.s, endSec: word.e })),
			});
			const seconds = (performance.now() - startedAt) / 1000;
			expect(result.words).toHaveLength(parakeet.length);

			const both: number[][] = [[], []];
			const all: number[][] = [[], []];
			let aligned = 0;
			let flagMismatch = 0;
			let referenceAligned = 0;
			result.words.forEach((word, i) => {
				const ref = reference[i] as ReferenceWord;
				if (word.aligned) aligned++;
				if (ref.aligned) referenceAligned++;
				if (word.aligned !== ref.aligned) flagMismatch++;
				const start = Math.abs(word.startSec - ref.s);
				const end = Math.abs(word.endSec - ref.e);
				all[0]?.push(start);
				all[1]?.push(end);
				if (word.aligned && ref.aligned) {
					both[0]?.push(start);
					both[1]?.push(end);
				}
			});
			const report = {
				words: parakeet.length,
				alignedShare: aligned / parakeet.length,
				referenceAlignedShare: referenceAligned / parakeet.length,
				alignedFlagMismatches: flagMismatch,
				alignSeconds: Number(seconds.toFixed(1)),
				bothAligned: {
					count: both[0]?.length,
					startMs: Object.fromEntries(
						Object.entries(summary(both[0] ?? [])).map(([k, v]) => [
							k,
							Number((v * 1000).toFixed(2)),
						]),
					),
					endMs: Object.fromEntries(
						Object.entries(summary(both[1] ?? [])).map(([k, v]) => [
							k,
							Number((v * 1000).toFixed(2)),
						]),
					),
				},
				allWords: {
					startMs: Object.fromEntries(
						Object.entries(summary(all[0] ?? [])).map(([k, v]) => [
							k,
							Number((v * 1000).toFixed(2)),
						]),
					),
					endMs: Object.fromEntries(
						Object.entries(summary(all[1] ?? [])).map(([k, v]) => [
							k,
							Number((v * 1000).toFixed(2)),
						]),
					),
				},
			};
			process.stdout.write(`ALIGN PARITY ${JSON.stringify(report)}\n`);

			for (const diffs of both) {
				const { median, p90 } = summary(diffs);
				expect(median).toBeLessThanOrEqual(0.01);
				expect(p90).toBeLessThanOrEqual(0.03);
			}
		} finally {
			helper.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParakeetProcess } from "../transcript/parakeetProcess";
import { CleanCutService, type CleanCutSnapshot, wordCachePath } from "./service";
import type { DecisionModel } from "./types";

const SOURCE = "/Users/olle/Downloads/2026-03-15 20-13-53.mp4";
const EXPECTED = "/Users/olle/Movies/OBS cutter test/retake-cut/kept.json";
const CACHE = path.join(homedir(), ".cache/retake-cutter");
const MODELS = path.join(homedir(), "Library/Application Support/Klippt/stt-models");
const NATIVE = path.join(process.cwd(), "electron/native/bin/darwin-arm64");
const FRAME = 1 / 60;

function pythonKey(file: string) {
	const stat = statSync(file, { bigint: true });
	return createHash("sha1")
		.update(`${realpathSync(file)}|${stat.size}|${stat.mtimeNs}`)
		.digest("hex")
		.slice(0, 16);
}

const replay: DecisionModel = {
	async ask(prompt, label) {
		const hash = createHash("sha256").update(`sonnet\n${prompt}`, "utf8").digest("hex");
		const hit = path.join(CACHE, "llm", `${label}-${hash.slice(0, 20)}.txt`);
		if (!existsSync(hit)) throw new Error(`No cached ${label} reply.`);
		return readFileSync(hit, "utf8");
	},
};

describe.skipIf(process.env.CLEAN_CUT_PARITY !== "1")("clean cut service end to end", () => {
	it("runs the real helper, aligner and engine on the OBS session and matches the prototype's cut", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-clean-cut-e2e-"));
		const cached = JSON.parse(
			readFileSync(path.join(CACHE, `${pythonKey(SOURCE)}.json`), "utf8"),
		) as Array<{ w: string; s: number; e: number }>;
		const seeded = await wordCachePath(dir, SOURCE);
		await mkdir(path.dirname(seeded), { recursive: true });
		await writeFile(
			seeded,
			JSON.stringify(cached.map((w) => ({ word: w.w, startSec: w.s, endSec: w.e, confidence: 1 }))),
		);
		let last: CleanCutSnapshot | null = null;
		const started = Date.now();
		const service = new CleanCutService({
			ffmpegPath: () => path.join(NATIVE, "ffmpeg"),
			transcriber: async () =>
				new ParakeetProcess({
					binaryPath: path.join(NATIVE, "klippt-parakeet-stt"),
					modelDir: path.join(MODELS, "parakeet-tdt-0.6b-v3"),
					startTimeoutMs: 10 * 60_000,
				}),
			alignerModels: async () => path.join(MODELS, "wav2vec2-base-960h-coreml"),
			claudeCheck: async () => true,
			model: () => replay,
			tempDir: path.join(dir, "tmp"),
			cacheDir: dir,
			onSnapshot: (snapshot) => {
				last = snapshot;
			},
		});
		await service.start("obs", [{ assetId: "obs", audioPath: SOURCE, offsetSec: 0 }], 1437.3);
		const result = last as unknown as CleanCutSnapshot;
		const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Array<{
			start: number;
			end: number;
		}>;
		// The live aligner places a few words slightly off the prototype's run, which can move or add
		// one or two cuts. Every other clip must land within a frame of the prototype's.
		const matched = expected.filter((e) =>
			result.keep.some(
				(k) => Math.abs(k.startSec - e.start) <= FRAME && Math.abs(k.endSec - e.end) <= FRAME,
			),
		).length;
		const summary = {
			state: result.state,
			error: result.error,
			seconds: Math.round((Date.now() - started) / 1000),
			clips: result.keep.length,
			expectedClips: expected.length,
			matched,
			regions: result.regions.length,
			risky: result.regions.filter((r) => r.risky).length,
			words: result.words.length,
			cleanSec: result.keep.reduce((n, k) => n + k.endSec - k.startSec, 0),
		};
		console.log("CLEAN CUT E2E", JSON.stringify(summary));
		expect(result.state).toBe("ready");
		expect(result.words).toHaveLength(cached.length);
		expect(Math.abs(result.keep.length - expected.length)).toBeLessThanOrEqual(2);
		expect(matched / expected.length).toBeGreaterThanOrEqual(0.97);
	}, 900_000);
});

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParakeetProcess } from "../transcript/parakeetProcess";
import { planCleanCut } from "./engine";
import { decodeMonoPcm16k } from "./ffmpegPcm";
import { ParakeetHesitationVetter } from "./parakeetVetter";
import type { CleanCutTake, DecisionModel } from "./types";

const SOURCE = "/Users/olle/Downloads/2026-03-15 20-13-53.mp4";
const EXPECTED = "/Users/olle/Movies/OBS cutter test/retake-cut";
const CACHE = path.join(homedir(), ".cache/retake-cutter");
const NATIVE = path.join(process.cwd(), "electron/native/bin/darwin-arm64");
const MODELS = path.join(
	homedir(),
	"Library/Application Support/Klippt/stt-models/parakeet-tdt-0.6b-v3",
);
const FRAME = 1 / 60;

function cacheKey(file: string): string {
	const stat = statSync(file, { bigint: true });
	return createHash("sha1")
		.update(`${realpathSync(file)}|${stat.size}|${stat.mtimeNs}`)
		.digest("hex")
		.slice(0, 16);
}

function replayModel(model: string): DecisionModel {
	return {
		async ask(prompt, label) {
			const hash = createHash("sha256").update(`${model}\n${prompt}`, "utf8").digest("hex");
			const hit = path.join(CACHE, "llm", `${label}-${hash.slice(0, 20)}.txt`);
			if (!existsSync(hit)) throw new Error(`No cached ${label} reply (${path.basename(hit)}).`);
			return readFileSync(hit, "utf8");
		},
	};
}

interface CachedWord {
	w: string;
	s: number;
	e: number;
}

function loadTake(pcm: Float32Array): CleanCutTake {
	const key = cacheKey(SOURCE);
	const read = (name: string): CachedWord[] =>
		JSON.parse(readFileSync(path.join(CACHE, name), "utf8"));
	const stat = statSync(SOURCE);
	return {
		id: SOURCE,
		folder: path.basename(path.dirname(SOURCE)),
		key: path.basename(SOURCE, path.extname(SOURCE)),
		recordedAtMs: stat.birthtimeMs,
		pcm,
		words: read(`${key}.json`).map((w) => ({
			word: w.w,
			startSec: w.s,
			endSec: w.e,
			confidence: 1,
		})),
		alignedTimes: read(`${key}-aligned-v1.json`).map((w) => ({ startSec: w.s, endSec: w.e })),
	};
}

async function startWithRetries(helper: ParakeetProcess, attempts = 3): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await helper.start();
			return;
		} catch (error) {
			if (attempt >= attempts) throw error;
		}
	}
}

describe.skipIf(!process.env.CLEAN_CUT_PARITY)("clean cut parity with the Python prototype", () => {
	it("matches kept.json and decisions.json on the 24-minute OBS recording", async () => {
		const decodeStart = performance.now();
		const pcm = await decodeMonoPcm16k(path.join(NATIVE, "ffmpeg"), SOURCE);
		const decodeSec = (performance.now() - decodeStart) / 1000;
		const take = loadTake(pcm);
		const helper = new ParakeetProcess({
			binaryPath: path.join(NATIVE, "klippt-parakeet-stt"),
			modelDir: MODELS,
		});
		await startWithRetries(helper);
		const vetter = new ParakeetHesitationVetter(
			helper,
			path.join(process.env.TMPDIR ?? "/tmp", "clean-cut-parity"),
		);
		let plan: Awaited<ReturnType<typeof planCleanCut>>;
		const engineStart = performance.now();
		try {
			plan = await planCleanCut({ takes: [take], model: replayModel("sonnet"), vetter });
		} finally {
			helper.stop();
		}
		const engineSec = (performance.now() - engineStart) / 1000;

		const kept: Array<{ start: number; end: number }> = JSON.parse(
			readFileSync(path.join(EXPECTED, "kept.json"), "utf8"),
		);
		const decisions: {
			cuts: Array<{ start: number; word: string; kind: string; reason: string; sources: string[] }>;
		} = JSON.parse(readFileSync(path.join(EXPECTED, "decisions.json"), "utf8"));
		const clips = plan.takes[0].clips;
		let maxDelta = 0;
		clips.forEach((c, i) => {
			if (!kept[i]) return;
			maxDelta = Math.max(
				maxDelta,
				Math.abs(c.startSec - kept[i].start),
				Math.abs(c.endSec - kept[i].end),
			);
		});
		const wordDiff = plan.dropped.filter((d, i) => {
			const e = decisions.cuts[i];
			return !e || d.word !== e.word || Math.abs(d.startSec - e.start) > 0.0051;
		}).length;
		console.info(
			JSON.stringify({
				decodeSec,
				engineSec,
				clips: clips.length,
				dropped: plan.dropped.length,
				wordDiff,
				maxDelta,
				stats: plan.stats,
				skipped: plan.skipped,
			}),
		);

		expect(plan.skipped).toEqual([]);
		expect(plan.dropped.length).toBe(decisions.cuts.length);
		expect(wordDiff).toBe(0);
		plan.dropped.forEach((d, i) => {
			const e = decisions.cuts[i];
			expect([d.kind, d.reason, d.sources]).toEqual([e.kind, e.reason, e.sources]);
		});
		expect(clips.length).toBe(kept.length);
		expect(maxDelta).toBeLessThanOrEqual(FRAME);
	}, 900_000);
});

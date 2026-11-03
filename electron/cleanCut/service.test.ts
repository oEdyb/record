import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { CleanCutService, type CleanCutServiceDeps, type CleanCutSnapshot } from "./service";
import type { CleanCutPlan } from "./types";

let dir: string;
let audio: string;
let snapshots: CleanCutSnapshot[];

const words = [{ word: "hello", startSec: 0.1, endSec: 0.4, confidence: 0.9 }];
const plan = {
	takes: [
		{ takeId: "a", clips: [{ startSec: 0, endSec: 1, firstWordIndex: 0, lastWordIndex: 0 }] },
	],
	cuts: [],
	dropped: [],
	stats: {},
	skipped: [],
} as unknown as CleanCutPlan;

function service(overrides: Partial<CleanCutServiceDeps> = {}) {
	const transcribe = vi.fn(async () => ({ words }));
	const deps: CleanCutServiceDeps = {
		ffmpegPath: () => "/bin/ffmpeg",
		transcriber: async () => ({ transcribe, stop: vi.fn() }),
		claudeCheck: async () => true,
		model: () => null,
		tempDir: path.join(dir, "tmp"),
		cacheDir: path.join(dir, "cache"),
		onSnapshot: (s) => snapshots.push(s),
		decode: vi.fn(async () => new Float32Array(16_000)),
		plan: vi.fn(async () => plan),
		...overrides,
	};
	return { service: new CleanCutService(deps), deps, transcribe };
}

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "klippt-clean-cut-"));
	audio = path.join(dir, "mic.wav");
	await writeFile(audio, "x");
	snapshots = [];
});

it("works in the background and publishes a ready view in source time", async () => {
	const { service: s } = service();
	await s.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0.25 }], 1);
	expect(snapshots[0]).toMatchObject({
		projectId: "p",
		state: "working",
		progress: 0,
		stage: "listening",
	});
	expect(snapshots.some((snap) => snap.stage === "aligning")).toBe(true);
	expect(s.snapshot()).toMatchObject({
		state: "ready",
		keep: [{ assetId: "a", startSec: 0.25, endSec: 1.25 }],
		words: [{ text: "hello", startSec: 0.35, regionId: null }],
		stage: null,
	});
});

it("reports the engine's stages as progress after the recordings are read", async () => {
	const { service: s } = service({
		plan: vi.fn(async (input) => {
			input.onProgress?.("checking", 0.5);
			input.onProgress?.("placing", 0.95);
			return plan;
		}),
	});
	await s.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
	expect(snapshots.map((snap) => [snap.stage, snap.progress]).slice(-3)).toEqual([
		["checking", 0.8],
		["placing", 0.98],
		[null, 1],
	]);
});

it("transcribes a recording once and reuses its words next time", async () => {
	const first = service();
	await first.service.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
	const second = service();
	await second.service.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
	expect(first.transcribe).toHaveBeenCalledTimes(1);
	expect(second.transcribe).toHaveBeenCalledTimes(0);
});

it("never publishes a cancelled run's result", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { service: s } = service({
		plan: vi.fn(async () => {
			await gate;
			return plan;
		}),
	});
	const running = s.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
	await vi.waitFor(() => expect(snapshots.at(-1)?.progress).toBeGreaterThan(0));
	s.cancel();
	release();
	await running;
	expect(s.snapshot().state).toBe("off");
	expect(snapshots.some((snapshot) => snapshot.state === "ready")).toBe(false);
});

it("reports a failure as a failed snapshot", async () => {
	const { service: s } = service({ ffmpegPath: () => null });
	await s.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
	expect(s.snapshot()).toMatchObject({ state: "failed", error: "Bundled FFmpeg is unavailable." });
});

it("says whether Claude checked the cut", async () => {
	const model = { ask: vi.fn(async () => "") };
	const cases = [
		{ on: false, model, skipped: [], expected: "off" },
		{ on: true, model: null, skipped: [], expected: "unavailable" },
		{ on: true, model, skipped: ["whole-session model pass: offline"], expected: "failed" },
		{ on: true, model, skipped: [], expected: "done" },
	] as const;
	for (const { on, model: m, skipped, expected } of cases) {
		const { service: s } = service({
			claudeCheck: async () => on,
			model: () => m,
			plan: vi.fn(async () => ({ ...plan, skipped: [...skipped] })),
		});
		await s.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
		expect(s.snapshot()).toMatchObject({ state: "ready", modelCheck: expected });
	}
});

it("never asks for a model while the Claude check is off", async () => {
	const model = vi.fn(() => ({ ask: vi.fn(async () => "") }));
	const { service: s, deps } = service({ claudeCheck: async () => false, model });
	await s.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
	expect(model).not.toHaveBeenCalled();
	expect(deps.plan).toHaveBeenCalledWith(expect.objectContaining({ model: null }));
});

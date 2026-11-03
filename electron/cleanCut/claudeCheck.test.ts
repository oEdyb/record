import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCheckSetting, cleanCutModelDeps } from "./claudeCheck";
import { CleanCutService, type CleanCutSnapshot } from "./service";
import type { CleanCutPlan } from "./types";

const TRANSCRIPT = "the secret words of this recording";
const posix = process.platform !== "win32";

let dir: string;
let received: string;
let settingFile: string;
let searchPath: string[];

const plan = {
	takes: [],
	cuts: [],
	dropped: [],
	stats: {},
	skipped: [],
} as unknown as CleanCutPlan;

async function runCleanCut(): Promise<CleanCutSnapshot> {
	const audio = path.join(dir, "mic.wav");
	await writeFile(audio, "x");
	const service = new CleanCutService({
		ffmpegPath: () => "/bin/ffmpeg",
		transcriber: async () => ({
			transcribe: async () => ({
				words: [{ word: "hello", startSec: 0.1, endSec: 0.4, confidence: 0.9 }],
			}),
			stop: vi.fn(),
		}),
		...cleanCutModelDeps({
			setting: new ClaudeCheckSetting(settingFile),
			cacheDir: path.join(dir, "replies"),
			searchPath,
		}),
		tempDir: path.join(dir, "tmp"),
		cacheDir: path.join(dir, "cache"),
		onSnapshot: () => undefined,
		decode: vi.fn(async () => new Float32Array(16_000)),
		plan: vi.fn(async ({ model }) => {
			await model?.ask(TRANSCRIPT, "units");
			return plan;
		}),
	});
	await service.start("p", [{ assetId: "a", audioPath: audio, offsetSec: 0 }], 1);
	return service.snapshot();
}

const sentToClaude = () => readFile(received, "utf8").catch(() => null);

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "klippt-claude-check-"));
	received = path.join(dir, "received.txt");
	settingFile = path.join(dir, "userData", "clean-cut", "settings.json");
	const bin = path.join(dir, "bin");
	await mkdir(bin);
	const fake = path.join(bin, "claude");
	await writeFile(fake, `#!/bin/sh\ncat > "${received}"\nprintf '{"drop":[]}'\n`);
	await chmod(fake, 0o755);
	searchPath = [bin];
});

describe.skipIf(!posix)("Clean cut and the Claude CLI", () => {
	it("sends nothing to a claude on the path when no setting was ever saved", async () => {
		expect(await runCleanCut()).toMatchObject({ state: "ready", modelCheck: "off" });
		expect(await sentToClaude()).toBeNull();
	});

	it("sends nothing for settings saved before this option existed, or anything but true", async () => {
		await mkdir(path.dirname(settingFile), { recursive: true });
		for (const saved of [
			"{}",
			'{"otherSetting":true}',
			'{"claudeCheck":"true"}',
			'{"claudeCheck":1}',
			'{"claudeCheck":false}',
			"not json",
		]) {
			await writeFile(settingFile, saved);
			expect(await runCleanCut()).toMatchObject({ modelCheck: "off" });
			expect(await sentToClaude()).toBeNull();
		}
	});

	it("sends the transcript only after the person turns the Claude check on", async () => {
		await new ClaudeCheckSetting(settingFile).set(true);
		expect(await runCleanCut()).toMatchObject({ state: "ready", modelCheck: "done" });
		expect(await sentToClaude()).toBe(TRANSCRIPT);
	});

	it("stops sending the moment the check is turned off again", async () => {
		const setting = new ClaudeCheckSetting(settingFile);
		await setting.set(true);
		await runCleanCut();
		await writeFile(received, "");
		await setting.set(false);
		expect(await runCleanCut()).toMatchObject({ modelCheck: "off" });
		expect(await sentToClaude()).toBe("");
	});

	it("says unavailable, not off, when the check is on but no claude is installed", async () => {
		await new ClaudeCheckSetting(settingFile).set(true);
		searchPath = [path.join(dir, "empty")];
		expect(await runCleanCut()).toMatchObject({ modelCheck: "unavailable" });
	});
});

describe("ClaudeCheckSetting", () => {
	it("defaults to off and round-trips", async () => {
		const setting = new ClaudeCheckSetting(path.join(dir, "nested", "settings.json"));
		expect(await setting.get()).toBe(false);
		await setting.set(true);
		expect(await setting.get()).toBe(true);
		await setting.set(false);
		expect(await setting.get()).toBe(false);
	});
});

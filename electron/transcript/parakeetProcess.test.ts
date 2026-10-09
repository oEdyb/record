import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidateParakeetBinaryPaths, ParakeetProcess } from "./parakeetProcess";

const FAKE_HELPER = `
const readline = require("node:readline");
const models = process.argv[process.argv.indexOf("--models") + 1];
process.stdout.write(JSON.stringify({ type: "ready", backend: "fake", models }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.audioPath.endsWith("bad.wav")) {
		process.stdout.write(JSON.stringify({ type: "error", id: request.id, error: "decode failed" }) + "\\n");
		return;
	}
	process.stdout.write(
		JSON.stringify({
			type: "result",
			id: request.id,
			segments: [{ text: "hello " + path(request.audioPath) }],
			detectedLanguage: "en",
		}) + "\\n",
	);
});
function path(file) { return file.split("/").pop(); }
`;

let dir: string;
let helper: ParakeetProcess;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "klippt-parakeet-"));
	const script = path.join(dir, "fake-helper.cjs");
	await writeFile(script, FAKE_HELPER);
	helper = new ParakeetProcess({
		binaryPath: process.execPath,
		modelDir: path.join(dir, "models"),
		spawnProcess: ((command: string, args: string[], options: object) =>
			spawn(command, [script, ...args], options)) as typeof spawn,
	});
});

afterEach(() => {
	helper.stop();
});

describe("ParakeetProcess", () => {
	it("starts once, answers requests by id, and surfaces helper errors per request", async () => {
		const [good, bad] = await Promise.all([
			helper.transcribe({ id: "a", audioPath: "/tmp/one.wav" }),
			helper.transcribe({ id: "b", audioPath: "/tmp/bad.wav" }).catch((error: Error) => error),
		]);
		expect(good).toEqual({ id: "a", text: "hello one.wav", detectedLanguage: "en" });
		expect(bad).toBeInstanceOf(Error);
		expect((bad as Error).message).toBe("decode failed");
		expect(helper.running).toBe(true);
	});

	it("rejects everything in flight when stopped", async () => {
		await helper.start();
		helper.stop();
		expect(helper.running).toBe(false);
	});

	it("searches the packaged helper locations with one explicit override first", () => {
		process.env.KLIPPT_PARAKEET_STT_EXE = "/override/klippt-parakeet-stt";
		try {
			const candidates = candidateParakeetBinaryPaths("/repo");
			expect(candidates[0]).toBe("/override/klippt-parakeet-stt");
			expect(candidates.at(-1)).toBe(
				path.join(
					"/repo",
					"electron",
					"native",
					"bin",
					`${process.platform}-${process.arch}`,
					"klippt-parakeet-stt",
				),
			);
		} finally {
			delete process.env.KLIPPT_PARAKEET_STT_EXE;
		}
	});
});

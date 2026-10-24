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
	if (request.type === "align") {
		if (!request.alignerModels.endsWith("aligner")) {
			process.stdout.write(JSON.stringify({ type: "error", id: request.id, error: "aligner missing" }) + "\\n");
			return;
		}
		const words = request.words.map((w) => ({
			startSec: Math.round((w.startSec + 0.01) * 1000) / 1000,
			endSec: Math.round((w.endSec + 0.01) * 1000) / 1000,
			aligned: /[a-z]/i.test(w.word),
		}));
		if (request.audioPath.endsWith("short.wav")) words.pop();
		process.stdout.write(JSON.stringify({ type: "aligned", id: request.id, words }) + "\\n");
		return;
	}
	if (request.audioPath.endsWith("bad.wav")) {
		process.stdout.write(JSON.stringify({ type: "error", id: request.id, error: "decode failed" }) + "\\n");
		return;
	}
	process.stdout.write(
		JSON.stringify({
			type: "result",
			id: request.id,
			segments: [{ text: "hello " + path(request.audioPath) }],
			wordSegments: [{ word: "hello", startSec: 0.2, endSec: 0.5, confidence: 0.8 }],
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
		expect(good).toEqual({
			id: "a",
			text: "hello one.wav",
			words: [{ word: "hello", startSec: 0.2, endSec: 0.5, confidence: 0.8 }],
			detectedLanguage: "en",
		});
		expect(bad).toBeInstanceOf(Error);
		expect((bad as Error).message).toBe("decode failed");
		expect(helper.running).toBe(true);
	});

	it("aligns words in request order and keeps transcription working on the same helper", async () => {
		const words = [
			{ word: "hello", startSec: 0.2, endSec: 0.5, confidence: 0.9 },
			{ word: "42", startSec: 0.6, endSec: 0.9, confidence: 0.4 },
		];
		const [aligned, transcript] = await Promise.all([
			helper.align({
				id: "al",
				audioPath: "/tmp/one.wav",
				words,
				alignerModels: "/models/aligner",
			}),
			helper.transcribe({ id: "tr", audioPath: "/tmp/one.wav" }),
		]);
		expect(aligned).toEqual({
			id: "al",
			words: [
				{ startSec: 0.21, endSec: 0.51, aligned: true },
				{ startSec: 0.61, endSec: 0.91, aligned: false },
			],
		});
		expect(transcript.text).toBe("hello one.wav");
	});

	it("rejects an align request on helper errors and on a changed word count", async () => {
		const words = [
			{ word: "a", startSec: 0, endSec: 1 },
			{ word: "b", startSec: 1, endSec: 2 },
		];
		await expect(
			helper.align({ id: "e1", audioPath: "/tmp/one.wav", words, alignerModels: "/models/nope" }),
		).rejects.toThrow("aligner missing");
		await expect(
			helper.align({
				id: "e2",
				audioPath: "/tmp/short.wav",
				words,
				alignerModels: "/models/aligner",
			}),
		).rejects.toThrow("aligned 1 words, expected 2");
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

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assignFixture,
	buildExtractionArguments,
	extractAsset,
	fixtureFingerprint,
	hashFile,
	hashJson,
	validateCorpus,
	validateResults,
	verifyMedia,
} from "./creator-corpus.mjs";

const temporaryDirectories = [];
const HASH_B = "b".repeat(64);

async function temporaryDirectory(prefix) {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function asset({ id = "source-screen", relativePath = "sources/screen.bin", bytes, sha256 }) {
	return {
		id,
		role: "screen",
		storage: { kind: "external", relativePath },
		sha256,
		bytes,
		mediaType: "application/octet-stream",
		consent: { basis: "synthetic", use: "internal" },
		device: { class: "synthetic" },
		video: { width: 2560, height: 1440, fps: "60/1", aspectRatio: "16:9" },
	};
}

const DOMAINS = ["capture", "export", "audio", "asr", "automatic-direction", "ui-performance"];

function fixture(assetId = "source-screen") {
	return {
		id: "creator-ui-basic",
		revision: 1,
		title: "Synthetic creator interface",
		durationMs: 10_000,
		assetIds: [assetId],
		languages: ["sv-SE", "en"],
		contexts: ["terminal", "typing", "drag-selection"],
		noiseConditions: ["none"],
		expectedInvariants: DOMAINS.map((domain) => ({
			id: `${domain}-gate`,
			domain,
			description: `${domain} remains inside its locked gate`,
			severity: "required",
			metric: "gate.value",
			operator: "eq",
			value: 0,
		})),
	};
}

async function writeCorpus({ assigned = true, mutateManifest, includeDerived = false } = {}) {
	const directory = await temporaryDirectory("klippt-creator-corpus-");
	const mediaRoot = path.join(directory, "media");
	await mkdir(path.join(mediaRoot, "sources"), { recursive: true });
	const sourceBytes = Buffer.from("deterministic creator corpus source\n");
	const sourcePath = path.join(mediaRoot, "sources", "screen.bin");
	await writeFile(sourcePath, sourceBytes);
	const sourceAsset = asset({
		bytes: sourceBytes.length,
		sha256: await hashFile(sourcePath),
	});
	const manifest = {
		schemaVersion: 1,
		corpusId: "klippt-creator-corpus",
		version: "1.0.0",
		description: "Test creator corpus",
		assets: [sourceAsset],
		fixtures: [fixture()],
	};
	if (includeDerived) {
		manifest.assets.push({
			...asset({
				id: "derived-screen",
				relativePath: "derived/screen.bin",
				bytes: sourceBytes.length,
				sha256: sourceAsset.sha256,
			}),
			derivation: {
				sourceAssetId: sourceAsset.id,
				startMs: 1250,
				durationMs: 2500,
				streamMaps: ["0:v:0"],
				mode: "packet-copy",
				ffmpegVersion: "fixture-1",
				ffmpegSha256: HASH_B,
			},
		});
	}
	mutateManifest?.(manifest);
	const assetsById = new Map(manifest.assets.map((item) => [item.id, item]));
	const splitLock = {
		schemaVersion: 1,
		corpusId: manifest.corpusId,
		assignments: assigned
			? [
					{
						fixtureId: manifest.fixtures[0].id,
						fixtureRevision: manifest.fixtures[0].revision,
						fixtureSha256: fixtureFingerprint(manifest.fixtures[0], assetsById),
						split: "holdout",
					},
				]
			: [],
	};
	const manifestPath = path.join(directory, "manifest.json");
	const splitLockPath = path.join(directory, "split-lock.json");
	await Promise.all([
		writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`),
		writeFile(splitLockPath, `${JSON.stringify(splitLock, null, "\t")}\n`),
	]);
	return {
		directory,
		mediaRoot,
		manifest,
		splitLock,
		manifestPath,
		splitLockPath,
		sourceAsset,
		sourceBytes,
	};
}

const MEASUREMENTS = {
	capture: {
		kind: "capture",
		durationMs: 10_000,
		requestedFps: 60,
		deliveredFps: 60,
		droppedFrames: 0,
		avDriftMs: 0,
		fatalWriterErrors: 0,
		mediaDiscontinuities: 0,
	},
	export: {
		kind: "export",
		durationMs: 10_000,
		wallTimeMs: 5000,
		throughputFps: 120,
		outputBytes: 1000,
		outputSha256: "c".repeat(64),
		hardwareEncoder: true,
		avDriftMs: 0,
		durationErrorMs: 0,
		peakRssBytes: 1000,
	},
	audio: {
		kind: "audio",
		samples: 480_000,
		sampleRate: 48_000,
		lagSamples: 0,
		inputLufs: -20,
		outputLufs: -14.5,
		inputTruePeakDbtp: -6,
		outputTruePeakDbtp: -2,
		correlation: 1,
	},
	asr: {
		kind: "asr",
		referenceWords: 20,
		wordErrors: 0,
		wer: 0,
		cer: 0,
		protectedTermErrors: 0,
		boundaryP50Ms: 10,
		boundaryP95Ms: 20,
		realTimeFactor: 0.1,
	},
	"automatic-direction": {
		kind: "automatic-direction",
		expectedEvents: 2,
		generatedEvents: 2,
		unchangedRate: 1,
		correctionSeconds: 0,
		deleteRate: 0,
		cursorContainmentRate: 1,
		privacyViolations: 0,
		previewExportMismatches: 0,
	},
	"ui-performance": {
		kind: "ui-performance",
		durationMs: 10_000,
		frames: 600,
		inputLatencyP50Ms: 8,
		inputLatencyP95Ms: 16,
		inputLatencyP99Ms: 24,
		longTasks: 0,
		droppedFrames: 0,
		peakRssBytes: 1000,
	},
};

function resultFor(corpus, kind) {
	return {
		schemaVersion: 1,
		runId: `run-${kind}`,
		createdAt: "2026-08-28T12:00:00.000Z",
		corpus: {
			id: corpus.manifest.corpusId,
			version: corpus.manifest.version,
			manifestSha256: hashJson(corpus.manifest),
			splitLockSha256: hashJson(corpus.splitLock),
		},
		fixture: {
			id: corpus.manifest.fixtures[0].id,
			revision: corpus.manifest.fixtures[0].revision,
			split: corpus.splitLock.assignments[0].split,
		},
		provenance: {
			sourceSha256: [corpus.sourceAsset.sha256],
			toolSha256: [HASH_B],
			modelSha256: kind === "asr" ? [HASH_B] : [],
			policySha256: [HASH_B],
		},
		environment: { platform: "darwin", arch: "arm64" },
		status: "passed",
		invariants: [{ id: `${kind}-gate`, passed: true, observed: 0 }],
		measurement: MEASUREMENTS[kind],
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("creator corpus", () => {
	it("validates the locked manifest and exact external media", async () => {
		const corpus = await writeCorpus();
		await expect(
			validateCorpus({ manifestPath: corpus.manifestPath, splitLockPath: corpus.splitLockPath }),
		).resolves.toMatchObject({ manifestSha256: hashJson(corpus.manifest) });
		await expect(
			verifyMedia({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				mediaRoot: corpus.mediaRoot,
			}),
		).resolves.toEqual({ assets: 1 });
	});

	it("fails when a fixture has no explicit split assignment", async () => {
		const corpus = await writeCorpus({ assigned: false });
		await expect(
			validateCorpus({ manifestPath: corpus.manifestPath, splitLockPath: corpus.splitLockPath }),
		).rejects.toThrow(/no locked split assignment/);
	});

	it("detects fixture changes against the split lock", async () => {
		const corpus = await writeCorpus();
		corpus.manifest.fixtures[0].title = "Changed after lock";
		await writeFile(corpus.manifestPath, `${JSON.stringify(corpus.manifest, null, "\t")}\n`);
		await expect(
			validateCorpus({ manifestPath: corpus.manifestPath, splitLockPath: corpus.splitLockPath }),
		).rejects.toThrow(/fingerprint does not match/);
	});

	it("adds one split assignment but refuses to move it later", async () => {
		const corpus = await writeCorpus({ assigned: false });
		await expect(
			assignFixture({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				fixtureId: corpus.manifest.fixtures[0].id,
				split: "holdout",
			}),
		).resolves.toMatchObject({ changed: true, assignment: { split: "holdout" } });
		await expect(
			assignFixture({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				fixtureId: corpus.manifest.fixtures[0].id,
				split: "tuning",
			}),
		).rejects.toThrow(/Refusing to move fixture/);
	});

	it.each([
		["absolute", "/Users/person/private.mov"],
		["parent traversal", "../private.mov"],
		["Windows absolute", "C:\\private.mov"],
	])("rejects %s asset paths", async (_label, relativePath) => {
		const corpus = await writeCorpus({
			mutateManifest(manifest) {
				manifest.assets[0].storage.relativePath = relativePath;
			},
		});
		await expect(
			validateCorpus({ manifestPath: corpus.manifestPath, splitLockPath: corpus.splitLockPath }),
		).rejects.toThrow(/schema/);
	});

	it("requires redistribution consent for committed fixtures", async () => {
		const corpus = await writeCorpus({
			mutateManifest(manifest) {
				manifest.assets[0].storage = {
					kind: "committed",
					relativePath: "creator-corpus/fixtures/sample.bin",
				};
			},
		});
		await expect(
			validateCorpus({ manifestPath: corpus.manifestPath, splitLockPath: corpus.splitLockPath }),
		).rejects.toThrow(/schema/);
	});

	it("requires source metadata for video and audio roles", async () => {
		const missingVideo = await writeCorpus({
			mutateManifest(manifest) {
				delete manifest.assets[0].video;
			},
		});
		await expect(
			validateCorpus({
				manifestPath: missingVideo.manifestPath,
				splitLockPath: missingVideo.splitLockPath,
			}),
		).rejects.toThrow(/schema/);

		const missingAudio = await writeCorpus({
			mutateManifest(manifest) {
				manifest.assets[0].role = "microphone";
				delete manifest.assets[0].video;
			},
		});
		await expect(
			validateCorpus({
				manifestPath: missingAudio.manifestPath,
				splitLockPath: missingAudio.splitLockPath,
			}),
		).rejects.toThrow(/schema/);
	});

	it("detects external media changes without storing a path in results", async () => {
		const corpus = await writeCorpus();
		await writeFile(path.join(corpus.mediaRoot, "sources", "screen.bin"), "changed\n");
		await expect(
			verifyMedia({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				mediaRoot: corpus.mediaRoot,
			}),
		).rejects.toThrow(/bytes do not match/);
	});

	it.skipIf(process.platform === "win32")(
		"rejects an external media symlink even when its bytes match",
		async () => {
			const corpus = await writeCorpus();
			const sourcePath = path.join(corpus.mediaRoot, "sources", "screen.bin");
			const outsidePath = path.join(corpus.directory, "outside.bin");
			await writeFile(outsidePath, corpus.sourceBytes);
			await rm(sourcePath);
			await symlink(outsidePath, sourcePath);
			await expect(
				verifyMedia({
					manifestPath: corpus.manifestPath,
					splitLockPath: corpus.splitLockPath,
					mediaRoot: corpus.mediaRoot,
				}),
			).rejects.toThrow(/symbolic link/);
		},
	);

	it("validates strict result records for all six measurement domains", async () => {
		const corpus = await writeCorpus();
		const resultDirectory = path.join(corpus.directory, "results");
		await mkdir(resultDirectory);
		await Promise.all(
			DOMAINS.map((kind) =>
				writeFile(
					path.join(resultDirectory, `${kind}.json`),
					`${JSON.stringify(resultFor(corpus, kind), null, "\t")}\n`,
				),
			),
		);
		await expect(
			validateResults({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				inputPath: resultDirectory,
			}),
		).resolves.toEqual({ results: 6 });
	});

	it("rejects private payload fields and stale corpus hashes in results", async () => {
		const corpus = await writeCorpus();
		const privateResult = resultFor(corpus, "asr");
		privateResult.transcript = "private words";
		const privatePath = path.join(corpus.directory, "private.json");
		await writeFile(privatePath, JSON.stringify(privateResult));
		await expect(
			validateResults({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				inputPath: privatePath,
			}),
		).rejects.toThrow(/schema/);

		const staleResult = resultFor(corpus, "asr");
		staleResult.corpus.manifestSha256 = "d".repeat(64);
		const stalePath = path.join(corpus.directory, "stale.json");
		await writeFile(stalePath, JSON.stringify(staleResult));
		await expect(
			validateResults({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				inputPath: stalePath,
			}),
		).rejects.toThrow(/does not match the locked corpus/);
	});

	it("requires the exact fixture sources and a truthful invariant outcome", async () => {
		const corpus = await writeCorpus({
			mutateManifest(manifest) {
				manifest.assets.push({
					...asset({ id: "source-camera", relativePath: "sources/camera.bin" }),
					sha256: "e".repeat(64),
					bytes: 12,
				});
				manifest.fixtures[0].assetIds.push("source-camera");
			},
		});
		const missingSource = resultFor(corpus, "capture");
		const missingSourcePath = path.join(corpus.directory, "missing-source.json");
		await writeFile(missingSourcePath, JSON.stringify(missingSource));
		await expect(
			validateResults({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				inputPath: missingSourcePath,
			}),
		).rejects.toThrow(/exact fixture source hashes/);

		const wrongOutcome = resultFor(corpus, "capture");
		wrongOutcome.provenance.sourceSha256.push("e".repeat(64));
		wrongOutcome.invariants[0].observed = 1;
		const wrongOutcomePath = path.join(corpus.directory, "wrong-outcome.json");
		await writeFile(wrongOutcomePath, JSON.stringify(wrongOutcome));
		await expect(
			validateResults({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				inputPath: wrongOutcomePath,
			}),
		).rejects.toThrow(/wrong outcome/);
	});

	it("rejects free-form result text and an ASR result without a model hash", async () => {
		const corpus = await writeCorpus();
		const privateObservation = resultFor(corpus, "asr");
		privateObservation.invariants[0].observed = "private spoken words";
		const privateObservationPath = path.join(corpus.directory, "private-observation.json");
		await writeFile(privateObservationPath, JSON.stringify(privateObservation));
		await expect(
			validateResults({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				inputPath: privateObservationPath,
			}),
		).rejects.toThrow(/schema/);

		const missingModel = resultFor(corpus, "asr");
		missingModel.provenance.modelSha256 = [];
		const missingModelPath = path.join(corpus.directory, "missing-model.json");
		await writeFile(missingModelPath, JSON.stringify(missingModel));
		await expect(
			validateResults({
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				inputPath: missingModelPath,
			}),
		).rejects.toThrow(/does not identify its model/);
	});

	it("builds one fixed bit-exact packet-copy extraction command", () => {
		const args = buildExtractionArguments({
			sourcePath: "/private/source.mp4",
			outputPath: "/private/output.mp4",
			derivation: {
				startMs: 1250,
				durationMs: 2500,
				streamMaps: ["0:v:0", "0:a:0?"],
			},
		});
		expect(args).toEqual(
			expect.arrayContaining([
				"-bitexact",
				"1.250",
				"2.500",
				"-map_metadata",
				"-map_chapters",
				"+bitexact",
			]),
		);
		expect(args.filter((value) => value === "/private/source.mp4")).toHaveLength(1);
		expect(args.at(-1)).toBe("/private/output.mp4");
	});

	it.skipIf(process.platform === "win32")(
		"extracts through a verified tool and never overwrites changed output",
		async () => {
			const corpus = await writeCorpus({ includeDerived: true });
			const fakeFfmpeg = path.join(corpus.directory, "fake-ffmpeg");
			await writeFile(
				fakeFfmpeg,
				`#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "-version") {
  console.log("ffmpeg fixture-1");
  process.exit(0);
}
const input = process.argv[process.argv.indexOf("-i") + 1];
fs.copyFileSync(input, process.argv.at(-1));
`,
			);
			await chmod(fakeFfmpeg, 0o755);
			corpus.manifest.assets[1].derivation.ffmpegSha256 = await hashFile(fakeFfmpeg);
			await writeFile(corpus.manifestPath, `${JSON.stringify(corpus.manifest, null, "\t")}\n`);

			const options = {
				manifestPath: corpus.manifestPath,
				splitLockPath: corpus.splitLockPath,
				assetId: "derived-screen",
				mediaRoot: corpus.mediaRoot,
				ffmpegPath: fakeFfmpeg,
			};
			await expect(extractAsset(options)).resolves.toMatchObject({ created: true });
			await expect(extractAsset(options)).resolves.toMatchObject({ created: false });
			const outputPath = path.join(corpus.mediaRoot, "derived", "screen.bin");
			await expect(readFile(outputPath)).resolves.toEqual(corpus.sourceBytes);
			await writeFile(outputPath, "changed output\n");
			await expect(extractAsset(options)).rejects.toThrow(/bytes do not match/);
		},
	);
});

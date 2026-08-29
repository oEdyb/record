#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(ROOT, "creator-corpus", "manifest.json");
const DEFAULT_SPLIT_LOCK = path.join(ROOT, "creator-corpus", "split-lock.json");
const SCHEMA_DIRECTORY = path.join(ROOT, "creator-corpus", "schemas");
const SPLITS = new Set(["development", "tuning", "holdout"]);
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

let validatorsPromise;

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function hashJson(value) {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function hashFile(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function validators() {
	if (!validatorsPromise) {
		validatorsPromise = (async () => {
			const readSchema = async (name) =>
				JSON.parse(await readFile(path.join(SCHEMA_DIRECTORY, name), "utf8"));
			const [manifestSchema, splitLockSchema, resultSchema] = await Promise.all([
				readSchema("manifest.schema.json"),
				readSchema("split-lock.schema.json"),
				readSchema("result.schema.json"),
			]);
			const ajv = new Ajv2020({ allErrors: true, strict: true });
			return {
				manifest: ajv.compile(manifestSchema),
				splitLock: ajv.compile(splitLockSchema),
				result: ajv.compile(resultSchema),
			};
		})();
	}
	return validatorsPromise;
}

function validationMessage(label, validate) {
	const details = (validate.errors ?? [])
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
	return `${label} does not match its schema: ${details}`;
}

async function readJson(filePath, label) {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read ${label} ${filePath}: ${error.message}`);
	}
}

function uniqueById(values, label) {
	const seen = new Set();
	for (const value of values) {
		if (seen.has(value.id)) throw new Error(`${label} has duplicate id: ${value.id}`);
		seen.add(value.id);
	}
}

export function fixtureFingerprint(fixture, assetsById) {
	return hashJson({
		fixture,
		assets: fixture.assetIds.map((assetId) => assetsById.get(assetId)),
	});
}

async function validateManifestStructure(manifest) {
	const { manifest: validate } = await validators();
	if (!validate(manifest)) throw new Error(validationMessage("Corpus manifest", validate));
	uniqueById(manifest.assets, "Corpus assets");
	uniqueById(manifest.fixtures, "Corpus fixtures");
	const assetsById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
	for (const asset of manifest.assets) {
		if (!asset.derivation) continue;
		if (asset.derivation.sourceAssetId === asset.id) {
			throw new Error(`Derived asset cannot use itself as its source: ${asset.id}`);
		}
		if (!assetsById.has(asset.derivation.sourceAssetId)) {
			throw new Error(
				`Derived asset ${asset.id} references missing source ${asset.derivation.sourceAssetId}`,
			);
		}
	}
	for (const fixture of manifest.fixtures) {
		for (const assetId of fixture.assetIds) {
			if (!assetsById.has(assetId)) {
				throw new Error(`Fixture ${fixture.id} references missing asset ${assetId}`);
			}
		}
		uniqueById(fixture.expectedInvariants, `Fixture ${fixture.id} invariants`);
	}
	return assetsById;
}

async function validateSplitLockStructure(splitLock) {
	const { splitLock: validate } = await validators();
	if (!validate(splitLock)) throw new Error(validationMessage("Corpus split lock", validate));
	const seen = new Set();
	for (const assignment of splitLock.assignments) {
		if (seen.has(assignment.fixtureId)) {
			throw new Error(`Split lock has duplicate fixture: ${assignment.fixtureId}`);
		}
		seen.add(assignment.fixtureId);
	}
}

export async function loadCorpus({
	manifestPath = DEFAULT_MANIFEST,
	splitLockPath = DEFAULT_SPLIT_LOCK,
} = {}) {
	const [manifest, splitLock] = await Promise.all([
		readJson(manifestPath, "corpus manifest"),
		readJson(splitLockPath, "corpus split lock"),
	]);
	return { manifest, splitLock, manifestPath, splitLockPath };
}

export async function validateCorpus(options = {}) {
	const corpus = await loadCorpus(options);
	const assetsById = await validateManifestStructure(corpus.manifest);
	await validateSplitLockStructure(corpus.splitLock);
	if (corpus.manifest.corpusId !== corpus.splitLock.corpusId) {
		throw new Error("Corpus manifest and split lock have different corpus IDs");
	}
	const fixturesById = new Map(corpus.manifest.fixtures.map((fixture) => [fixture.id, fixture]));
	const assignmentsById = new Map(
		corpus.splitLock.assignments.map((assignment) => [assignment.fixtureId, assignment]),
	);
	for (const assignment of corpus.splitLock.assignments) {
		const fixture = fixturesById.get(assignment.fixtureId);
		if (!fixture) throw new Error(`Split lock references missing fixture: ${assignment.fixtureId}`);
		if (assignment.fixtureRevision !== fixture.revision) {
			throw new Error(`Fixture revision does not match split lock: ${fixture.id}`);
		}
		if (assignment.fixtureSha256 !== fixtureFingerprint(fixture, assetsById)) {
			throw new Error(`Fixture fingerprint does not match split lock: ${fixture.id}`);
		}
	}
	for (const fixture of corpus.manifest.fixtures) {
		if (!assignmentsById.has(fixture.id)) {
			throw new Error(`Fixture has no locked split assignment: ${fixture.id}`);
		}
	}
	return {
		...corpus,
		assetsById,
		fixturesById,
		assignmentsById,
		manifestSha256: hashJson(corpus.manifest),
		splitLockSha256: hashJson(corpus.splitLock),
	};
}

async function atomicWriteJson(filePath, value) {
	const directory = path.dirname(filePath);
	await mkdir(directory, { recursive: true });
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
	const handle = await open(temporaryPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporaryPath, filePath);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

export async function assignFixture({ fixtureId, split, ...paths }) {
	if (!SPLITS.has(split)) throw new Error(`Unknown corpus split: ${split}`);
	const corpus = await loadCorpus(paths);
	const assetsById = await validateManifestStructure(corpus.manifest);
	await validateSplitLockStructure(corpus.splitLock);
	if (corpus.manifest.corpusId !== corpus.splitLock.corpusId) {
		throw new Error("Corpus manifest and split lock have different corpus IDs");
	}
	const fixture = corpus.manifest.fixtures.find((candidate) => candidate.id === fixtureId);
	if (!fixture) throw new Error(`Unknown corpus fixture: ${fixtureId}`);
	const existing = corpus.splitLock.assignments.find(
		(assignment) => assignment.fixtureId === fixtureId,
	);
	if (existing) {
		if (existing.split !== split) {
			throw new Error(`Refusing to move fixture ${fixtureId} from ${existing.split} to ${split}`);
		}
		if (
			existing.fixtureRevision !== fixture.revision ||
			existing.fixtureSha256 !== fixtureFingerprint(fixture, assetsById)
		) {
			throw new Error(`Locked fixture changed and needs an explicit metadata review: ${fixtureId}`);
		}
		return { changed: false, assignment: existing };
	}
	const assignment = {
		fixtureId,
		fixtureRevision: fixture.revision,
		fixtureSha256: fixtureFingerprint(fixture, assetsById),
		split,
	};
	corpus.splitLock.assignments.push(assignment);
	corpus.splitLock.assignments.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
	await atomicWriteJson(corpus.splitLockPath, corpus.splitLock);
	await validateCorpus({ manifestPath: corpus.manifestPath, splitLockPath: corpus.splitLockPath });
	return { changed: true, assignment };
}

function isInside(root, candidate) {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function storagePath(asset, { mediaRoot, forOutput = false } = {}) {
	const base = asset.storage.kind === "committed" ? ROOT : mediaRoot;
	if (!base) throw new Error(`External asset ${asset.id} requires --media-root`);
	const resolvedBase = await realpath(path.resolve(base));
	const candidate = path.resolve(resolvedBase, asset.storage.relativePath);
	if (!isInside(resolvedBase, candidate)) {
		throw new Error(`Asset path escapes its approved root: ${asset.id}`);
	}
	if (forOutput) {
		await mkdir(path.dirname(candidate), { recursive: true });
		const resolvedParent = await realpath(path.dirname(candidate));
		if (!isInside(resolvedBase, resolvedParent)) {
			throw new Error(`Asset output parent escapes its approved root: ${asset.id}`);
		}
		try {
			if ((await lstat(candidate)).isSymbolicLink()) {
				throw new Error(`Corpus asset cannot be a symbolic link: ${asset.id}`);
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		return candidate;
	}
	const resolvedCandidate = await realpath(candidate);
	if (!isInside(resolvedBase, resolvedCandidate)) {
		throw new Error(`Asset path escapes its approved root through a symbolic link: ${asset.id}`);
	}
	if ((await lstat(candidate)).isSymbolicLink()) {
		throw new Error(`Corpus asset cannot be a symbolic link: ${asset.id}`);
	}
	return resolvedCandidate;
}

async function verifyAssetFile(asset, filePath) {
	const [details, digest] = await Promise.all([stat(filePath), hashFile(filePath)]);
	if (!details.isFile()) throw new Error(`Corpus asset is not a regular file: ${asset.id}`);
	if (details.size !== asset.bytes || digest !== asset.sha256) {
		throw new Error(`Corpus asset bytes do not match the manifest: ${asset.id}`);
	}
	return filePath;
}

export async function verifyMedia({ mediaRoot, ...paths } = {}) {
	const corpus = await validateCorpus(paths);
	for (const asset of corpus.manifest.assets) {
		const filePath = await storagePath(asset, { mediaRoot });
		await verifyAssetFile(asset, filePath);
	}
	return { assets: corpus.manifest.assets.length };
}

function seconds(milliseconds) {
	return (milliseconds / 1000).toFixed(3);
}

export function buildExtractionArguments({ sourcePath, outputPath, derivation }) {
	const mappings = derivation.streamMaps.flatMap((selector) => ["-map", selector]);
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-bitexact",
		"-ss",
		seconds(derivation.startMs),
		"-i",
		sourcePath,
		"-t",
		seconds(derivation.durationMs),
		...mappings,
		"-map_metadata",
		"-1",
		"-map_chapters",
		"-1",
		"-c",
		"copy",
		"-avoid_negative_ts",
		"make_zero",
		"-fflags",
		"+bitexact",
		"-metadata",
		"creation_time=1970-01-01T00:00:00Z",
		"-y",
		outputPath,
	];
}

async function publishWithoutOverwrite(temporaryPath, outputPath, asset) {
	try {
		await link(temporaryPath, outputPath);
		await unlink(temporaryPath);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		await rm(temporaryPath, { force: true });
		await verifyAssetFile(asset, outputPath);
	}
}

export async function extractAsset({ assetId, ffmpegPath, mediaRoot, ...paths }) {
	if (!ffmpegPath) throw new Error("Fixture extraction requires --ffmpeg");
	const corpus = await validateCorpus(paths);
	const asset = corpus.assetsById.get(assetId);
	if (!asset) throw new Error(`Unknown corpus asset: ${assetId}`);
	if (!asset.derivation) throw new Error(`Corpus asset has no extraction recipe: ${assetId}`);
	const source = corpus.assetsById.get(asset.derivation.sourceAssetId);
	const sourcePath = await storagePath(source, { mediaRoot });
	await verifyAssetFile(source, sourcePath);
	const resolvedFfmpeg = await realpath(path.resolve(ffmpegPath));
	if ((await hashFile(resolvedFfmpeg)) !== asset.derivation.ffmpegSha256) {
		throw new Error("FFmpeg binary does not match the extraction recipe");
	}
	const { stdout } = await execFileAsync(resolvedFfmpeg, ["-version"], {
		maxBuffer: MAX_TOOL_OUTPUT_BYTES,
		timeout: 30_000,
	});
	if (!String(stdout).split("\n", 1)[0].includes(asset.derivation.ffmpegVersion)) {
		throw new Error("FFmpeg version does not match the extraction recipe");
	}
	const outputPath = await storagePath(asset, { mediaRoot, forOutput: true });
	try {
		await verifyAssetFile(asset, outputPath);
		return { created: false, outputPath };
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (path.resolve(sourcePath) === path.resolve(outputPath)) {
		throw new Error("Fixture extraction source and output must differ");
	}
	const extension = path.extname(outputPath);
	const temporaryPath = path.join(
		path.dirname(outputPath),
		`.${path.basename(outputPath, extension)}.${randomUUID()}.partial${extension}`,
	);
	try {
		await execFileAsync(
			resolvedFfmpeg,
			buildExtractionArguments({
				sourcePath,
				outputPath: temporaryPath,
				derivation: asset.derivation,
			}),
			{ maxBuffer: MAX_TOOL_OUTPUT_BYTES, timeout: 10 * 60_000 },
		);
		await verifyAssetFile(asset, temporaryPath);
		await publishWithoutOverwrite(temporaryPath, outputPath, asset);
		return { created: true, outputPath };
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

async function resultFiles(inputPath) {
	const details = await stat(inputPath);
	if (details.isFile()) return [inputPath];
	if (!details.isDirectory()) throw new Error("Result input must be a JSON file or directory");
	return (await readdir(inputPath, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(inputPath, entry.name))
		.sort();
}

function invariantPasses(invariant, observed) {
	switch (invariant.operator) {
		case "eq":
			return Object.is(observed, invariant.value);
		case "lte":
			return typeof observed === "number" && typeof invariant.value === "number"
				? observed <= invariant.value
				: null;
		case "gte":
			return typeof observed === "number" && typeof invariant.value === "number"
				? observed >= invariant.value
				: null;
		case "between":
			return typeof observed === "number" && Array.isArray(invariant.value)
				? observed >= invariant.value[0] && observed <= invariant.value[1]
				: null;
		case "contains":
			return typeof observed === "string" && typeof invariant.value === "string"
				? observed.includes(invariant.value)
				: null;
		default:
			return null;
	}
}

export async function validateResults({ inputPath, ...paths }) {
	if (!inputPath) throw new Error("Result validation requires --input");
	const corpus = await validateCorpus(paths);
	const { result: validate } = await validators();
	const files = await resultFiles(path.resolve(inputPath));
	if (files.length === 0) throw new Error("Result directory has no JSON files");
	for (const file of files) {
		const result = await readJson(file, "corpus result");
		if (!validate(result)) throw new Error(validationMessage(`Corpus result ${file}`, validate));
		if (
			result.corpus.id !== corpus.manifest.corpusId ||
			result.corpus.version !== corpus.manifest.version ||
			result.corpus.manifestSha256 !== corpus.manifestSha256 ||
			result.corpus.splitLockSha256 !== corpus.splitLockSha256
		) {
			throw new Error(`Corpus result does not match the locked corpus: ${file}`);
		}
		const fixture = corpus.fixturesById.get(result.fixture.id);
		const assignment = corpus.assignmentsById.get(result.fixture.id);
		if (
			!fixture ||
			!assignment ||
			result.fixture.revision !== fixture.revision ||
			result.fixture.split !== assignment.split
		) {
			throw new Error(`Corpus result references the wrong fixture revision or split: ${file}`);
		}
		const sourceHashes = new Set(fixture.assetIds.map((id) => corpus.assetsById.get(id).sha256));
		const resultSourceHashes = new Set(result.provenance.sourceSha256);
		if (
			sourceHashes.size !== resultSourceHashes.size ||
			[...sourceHashes].some((hash) => !resultSourceHashes.has(hash))
		) {
			throw new Error(`Corpus result does not contain the exact fixture source hashes: ${file}`);
		}
		if (result.measurement.kind === "asr" && result.provenance.modelSha256.length === 0) {
			throw new Error(`ASR result does not identify its model: ${file}`);
		}
		const expected = new Map(
			fixture.expectedInvariants
				.filter((invariant) => invariant.domain === result.measurement.kind)
				.map((invariant) => [invariant.id, invariant]),
		);
		uniqueById(result.invariants, `Corpus result ${file} invariants`);
		const observed = new Map(result.invariants.map((invariant) => [invariant.id, invariant]));
		for (const [invariantId, invariant] of expected) {
			const observation = observed.get(invariantId);
			if (!observation) {
				throw new Error(`Corpus result omits expected invariant ${invariantId}: ${file}`);
			}
			const calculated = invariantPasses(invariant, observation.observed);
			if (calculated === null) {
				throw new Error(
					`Corpus invariant uses incompatible operator and value types: ${invariantId}`,
				);
			}
			if (observation.passed !== calculated) {
				throw new Error(`Corpus invariant reports the wrong outcome: ${invariantId}`);
			}
		}
		for (const invariantId of observed.keys()) {
			if (!expected.has(invariantId)) {
				throw new Error(`Corpus result contains an unexpected invariant ${invariantId}: ${file}`);
			}
		}
		if (result.status === "passed" && [...observed.values()].some((item) => !item.passed)) {
			throw new Error(`Corpus result reports passed while an invariant failed: ${file}`);
		}
	}
	return { results: files.length };
}

function parseArguments(argv) {
	const [command, ...rest] = argv;
	if (!command) throw new Error("Missing creator-corpus command");
	const values = { command };
	for (let index = 0; index < rest.length; index += 2) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
			throw new Error(`Invalid creator-corpus option near ${flag ?? "end of command"}`);
		}
		if (values[flag]) throw new Error(`Duplicate creator-corpus option: ${flag}`);
		values[flag] = value;
	}
	return values;
}

function pathOptions(args) {
	return {
		manifestPath: args["--manifest"] ? path.resolve(args["--manifest"]) : DEFAULT_MANIFEST,
		splitLockPath: args["--split-lock"] ? path.resolve(args["--split-lock"]) : DEFAULT_SPLIT_LOCK,
	};
}

async function main(argv) {
	const args = parseArguments(argv);
	const paths = pathOptions(args);
	if (args.command === "validate") {
		const corpus = await validateCorpus(paths);
		console.log(
			`Creator corpus ${corpus.manifest.version}: ${corpus.manifest.fixtures.length} fixtures, ${corpus.manifest.assets.length} assets`,
		);
		return;
	}
	if (args.command === "assign") {
		const result = await assignFixture({
			...paths,
			fixtureId: args["--fixture"],
			split: args["--split"],
		});
		console.log(
			`${result.changed ? "Assigned" : "Already assigned"} ${result.assignment.fixtureId} to ${result.assignment.split}`,
		);
		return;
	}
	if (args.command === "verify-media") {
		const result = await verifyMedia({ ...paths, mediaRoot: args["--media-root"] });
		console.log(`Verified ${result.assets} corpus assets`);
		return;
	}
	if (args.command === "validate-results") {
		const result = await validateResults({
			...paths,
			inputPath: args["--input"],
		});
		console.log(`Validated ${result.results} corpus results`);
		return;
	}
	if (args.command === "extract") {
		const result = await extractAsset({
			...paths,
			assetId: args["--asset"],
			mediaRoot: args["--media-root"],
			ffmpegPath: args["--ffmpeg"],
		});
		console.log(`${result.created ? "Created" : "Verified"} corpus asset ${args["--asset"]}`);
		return;
	}
	throw new Error(`Unknown creator-corpus command: ${args.command}`);
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}

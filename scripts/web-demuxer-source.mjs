#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_POLICY_PATH = path.join(DEFAULT_ROOT, "supply-chain", "web-demuxer.json");
const MAX_SOURCE_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireValue(condition, message) {
	if (!condition) throw new Error(message);
}

export function sourceArchivesForPolicy(policy) {
	return [...(policy.sourceArchives ?? []), ...(policy.nativeFfmpeg?.sourceArchives ?? [])];
}

export function sourceOfferFileNames(policy) {
	return [
		...sourceArchivesForPolicy(policy).map((archive) => archive.fileName),
		`web-demuxer-${policy.package.version}-source-manifest.json`,
		`web-demuxer-${policy.package.version}-relinking.txt`,
	];
}

export function loadWebDemuxerPolicy(policyPath = DEFAULT_POLICY_PATH) {
	const policy = readJson(policyPath);
	requireValue(policy?.schemaVersion === 1, "Unsupported web-demuxer policy schema");
	requireValue(policy.package?.name === "web-demuxer", "Invalid web-demuxer package policy");
	requireValue(/^\d+\.\d+\.\d+$/.test(policy.package?.version), "Invalid package version");
	requireValue(/^[0-9a-f]{40}$/.test(policy.package?.commit), "Invalid wrapper commit");
	requireValue(/^[0-9a-f]{40}$/.test(policy.ffmpeg?.commit), "Invalid FFmpeg commit");
	requireValue(/^[0-9a-f]{64}$/.test(policy.binary?.sha256), "Invalid WebAssembly hash");
	requireValue(Number.isSafeInteger(policy.binary?.size), "Invalid WebAssembly size");
	requireValue(
		Array.isArray(policy.sourceArchives) && policy.sourceArchives.length === 2,
		"The source offer must contain the wrapper and FFmpeg archives",
	);
	requireValue(
		policy.nativeFfmpeg?.license === "LGPL-2.1-or-later",
		"Native FFmpeg must remain under LGPL-2.1-or-later",
	);
	requireValue(
		/^[0-9a-f]{40}$/.test(policy.nativeFfmpeg?.btbn?.buildCommit),
		"Invalid BtbN build commit",
	);
	requireValue(
		/^[0-9a-f]{40}$/.test(policy.nativeFfmpeg?.btbn?.ffmpegCommit),
		"Invalid BtbN FFmpeg commit",
	);
	for (const target of ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64"]) {
		requireValue(
			policy.nativeFfmpeg.btbn.buildCommands?.[target]?.includes("lgpl-shared"),
			`Missing LGPL BtbN build command for ${target}`,
		);
	}
	const sourceArchives = sourceArchivesForPolicy(policy);
	requireValue(sourceArchives.length === 5, "The LGPL source offer must contain five archives");
	requireValue(
		new Set(sourceArchives.map((archive) => archive.fileName)).size === sourceArchives.length,
		"Source offer filenames must be unique",
	);
	for (const archive of sourceArchives) {
		requireValue(
			/^[a-z0-9.-]+$/.test(archive.fileName),
			`Invalid source filename: ${archive.fileName}`,
		);
		requireValue(archive.url?.startsWith("https://"), `Invalid source URL: ${archive.url}`);
		requireValue(Number.isSafeInteger(archive.size), `Invalid source size: ${archive.fileName}`);
		requireValue(/^[0-9a-f]{64}$/.test(archive.sha256), `Invalid source hash: ${archive.fileName}`);
	}
	return policy;
}

export async function verifyWebDemuxerSourcePolicy({
	root = DEFAULT_ROOT,
	policyPath = path.join(root, "supply-chain", "web-demuxer.json"),
} = {}) {
	const policy = loadWebDemuxerPolicy(policyPath);
	const lock = readJson(path.join(root, "package-lock.json"));
	const packageEntry = lock.packages?.["node_modules/web-demuxer"];
	requireValue(
		packageEntry?.version === policy.package.version,
		"web-demuxer lock version changed",
	);
	requireValue(
		packageEntry?.resolved === policy.package.npmTarball,
		"web-demuxer npm tarball changed",
	);
	requireValue(
		packageEntry?.integrity === policy.package.npmIntegrity,
		"web-demuxer npm integrity changed",
	);

	const [shipped, installed] = await Promise.all([
		readFile(path.join(root, policy.binary.path)),
		readFile(path.join(root, policy.binary.npmPath)),
	]);
	requireValue(shipped.length === policy.binary.size, "Shipped web-demuxer.wasm size changed");
	requireValue(sha256(shipped) === policy.binary.sha256, "Shipped web-demuxer.wasm hash changed");
	requireValue(
		shipped.equals(installed),
		"Shipped web-demuxer.wasm differs from the locked npm file",
	);
	return policy;
}

async function downloadArchive(archive, fetchImpl) {
	const response = await fetchImpl(archive.url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		headers: { "User-Agent": "Klippt-source-offer/1" },
	});
	if (!response.ok) throw new Error(`Source download failed (${response.status}): ${archive.url}`);
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_ARCHIVE_BYTES) {
		throw new Error(`Source archive is too large: ${archive.fileName}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_SOURCE_ARCHIVE_BYTES) {
		throw new Error(`Source archive is too large: ${archive.fileName}`);
	}
	if (bytes.length !== archive.size) throw new Error(`Source size mismatch: ${archive.fileName}`);
	if (sha256(bytes) !== archive.sha256)
		throw new Error(`Source hash mismatch: ${archive.fileName}`);
	return bytes;
}

function relinkingInstructions(policy) {
	return `Klippt web-demuxer ${policy.package.version} corresponding source and relinking instructions

The shipped WebAssembly file is a separate replaceable resource. It combines the MIT-licensed
web-demuxer wrapper with an LGPL-2.1-or-later FFmpeg build. The source archives beside this file
contain the exact wrapper and FFmpeg revisions used by the shipped binary.

Exact inputs
- web-demuxer: ${policy.package.repository}/commit/${policy.package.commit}
- FFmpeg: ${policy.ffmpeg.repository}/commit/${policy.ffmpeg.commit}
- Emscripten: ${policy.toolchain.emscriptenVersion}
- Linux amd64 build image: ${policy.toolchain.linuxAmd64Image}

Rebuild
1. Extract ${policy.sourceArchives[0].fileName}.
2. Extract ${policy.sourceArchives[1].fileName} into the wrapper's lib/FFmpeg directory.
3. Run the pinned amd64 Emscripten image. The exact configure and link flags are in
   web-demuxer-${policy.package.version}-source-manifest.json and in the wrapper Makefile.
4. Run: make ffmpeg-lib web-demuxer
5. Verify src/lib/web-demuxer.wasm, or use your modified build.

Replace
- In a packaged Klippt installation, replace the standalone resources/web-demuxer.wasm file.
- A signed macOS app must be re-signed after a local modification. This does not limit your right
  to rebuild, replace, and debug the LGPL-covered component.

Klippt support does not cover modified builds. The GNU LGPL 2.1 text is available at
https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html.
`;
}

export async function buildWebDemuxerSourceOffer({
	root = DEFAULT_ROOT,
	outputDir,
	policyPath = path.join(root, "supply-chain", "web-demuxer.json"),
	fetchImpl = fetch,
} = {}) {
	if (!outputDir) throw new Error("A source-offer output directory is required");
	const policy = await verifyWebDemuxerSourcePolicy({ root, policyPath });
	const parent = path.dirname(outputDir);
	const staging = path.join(parent, `.web-demuxer-source-${randomUUID()}`);
	await mkdir(parent, { recursive: true });
	await mkdir(staging);
	try {
		const sourceArchives = sourceArchivesForPolicy(policy);
		const downloaded = await Promise.all(
			sourceArchives.map(async (archive) => ({
				archive,
				bytes: await downloadArchive(archive, fetchImpl),
			})),
		);
		for (const { archive, bytes } of downloaded) {
			await writeFile(path.join(staging, archive.fileName), bytes, { flag: "wx" });
		}
		const policyBytes = await readFile(policyPath);
		const manifestName = `web-demuxer-${policy.package.version}-source-manifest.json`;
		const manifest = {
			schemaVersion: 1,
			component: `web-demuxer ${policy.package.version}`,
			policySha256: sha256(policyBytes),
			binary: policy.binary,
			package: policy.package,
			ffmpeg: policy.ffmpeg,
			nativeFfmpeg: policy.nativeFfmpeg,
			toolchain: policy.toolchain,
			build: policy.build,
			files: sourceArchives.map(({ fileName, size, sha256: hash, targets }) => ({
				fileName,
				size,
				sha256: hash,
				...(targets ? { targets } : {}),
			})),
		};
		await writeFile(path.join(staging, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, {
			flag: "wx",
		});
		await writeFile(
			path.join(staging, `web-demuxer-${policy.package.version}-relinking.txt`),
			relinkingInstructions(policy),
			{ flag: "wx" },
		);
		try {
			await stat(outputDir);
			throw new Error(`Source-offer output already exists: ${outputDir}`);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		await rename(staging, outputDir);
		return { policy, outputDir };
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

function option(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const args = process.argv.slice(2);
	const outputDir = option(args, "--output-dir");
	if (outputDir) {
		await buildWebDemuxerSourceOffer({ outputDir: path.resolve(outputDir) });
		console.log(`Web-demuxer source offer: ${path.resolve(outputDir)}`);
	} else {
		await verifyWebDemuxerSourcePolicy();
		console.log("web-demuxer source, package, and shipped WebAssembly match");
	}
}

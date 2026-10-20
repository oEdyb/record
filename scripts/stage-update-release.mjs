#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs, {
	closeSync,
	copyFileSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	isNativeFfmpegEvidenceFileName,
	nativeFfmpegEvidenceFileNames,
} from "./native-ffmpeg-source.mjs";
import {
	ELECTRON_FEED_FILES,
	feedFilesForTargets,
	RELEASE_TARGETS,
	validateElectronUpdateFeeds,
} from "./update-feed-integrity.mjs";
import { loadWebDemuxerPolicy, sourceOfferFileNames } from "./web-demuxer-source.mjs";

const UPDATE_BASE_URL = "https://updates.dyberg.co/klippt";
const FEED_FILES = new Set(ELECTRON_FEED_FILES);
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const WEB_DEMUXER_POLICY = loadWebDemuxerPolicy();
const SOURCE_OFFER_FILES = new Set(sourceOfferFileNames(WEB_DEMUXER_POLICY));
const DOWNLOADS = {
	"darwin-arm64": {
		pattern: (v) => `^Klippt-macOS-Apple-Silicon-${v}\\.dmg$`,
		label: "Apple Silicon DMG",
	},
	"darwin-x64": { pattern: (v) => `^Klippt-macOS-Intel-${v}\\.dmg$`, label: "Intel DMG" },
	"win32-x64": { pattern: (v) => `^Klippt\\.Setup\\.${v}\\.exe$`, label: "Windows installer" },
	"linux-x64": { pattern: (v) => `^Klippt-Linux-${v}\\.AppImage$`, label: "Linux AppImage" },
};

function listFiles(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(root, entry.name);
		return entry.isDirectory() ? listFiles(absolute) : [absolute];
	});
}

function matchesSingle(fileNames, pattern, label) {
	const matches = fileNames.filter((name) => pattern.test(name));
	if (matches.length !== 1) {
		throw new Error(`expected exactly one ${label}, got ${matches.length}`);
	}
	return matches[0];
}

function sha512File(filePath) {
	const hash = createHash("sha512");
	const descriptor = openSync(filePath, "r");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		let bytesRead;
		do {
			bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
		} while (bytesRead > 0);
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("base64");
}

export function buildReleaseManifest(
	fileNames,
	version,
	baseUrl = UPDATE_BASE_URL,
	targets = RELEASE_TARGETS,
) {
	const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const manifest = {
		version,
		downloads: Object.fromEntries(
			Object.keys(DOWNLOADS)
				.filter((target) => targets.includes(target))
				.map((target) => [
					target,
					matchesSingle(
						fileNames,
						new RegExp(DOWNLOADS[target].pattern(escapedVersion)),
						DOWNLOADS[target].label,
					),
				]),
		),
	};

	return {
		...manifest,
		downloads: Object.fromEntries(
			Object.entries(manifest.downloads).map(([key, fileName]) => [
				key,
				`${baseUrl}/${encodeURIComponent(fileName)}`,
			]),
		),
	};
}

function isUpdateArtifact(fileName) {
	return (
		FEED_FILES.has(fileName) ||
		SOURCE_OFFER_FILES.has(fileName) ||
		isNativeFfmpegEvidenceFileName(fileName) ||
		/\.(?:dmg|zip|exe|blockmap|AppImage|deb|rpm|pacman)$/.test(fileName)
	);
}

export function stageUpdateRelease(
	sourceRoot,
	version,
	outputRoot,
	sourceSha,
	targets = RELEASE_TARGETS,
) {
	const feedFiles = feedFilesForTargets(targets);
	const nativeFfmpegEvidenceFiles = targets.flatMap(nativeFfmpegEvidenceFileNames);
	const sourceFiles = listFiles(sourceRoot).filter((file) => isUpdateArtifact(path.basename(file)));
	const seen = new Set();
	mkdirSync(outputRoot, { recursive: true });

	for (const sourceFile of sourceFiles) {
		const fileName = path.basename(sourceFile);
		if (seen.has(fileName)) throw new Error(`duplicate release filename: ${fileName}`);
		seen.add(fileName);
		copyFileSync(sourceFile, path.join(outputRoot, fileName));
	}

	for (const feedFile of feedFiles) {
		if (!seen.has(feedFile)) throw new Error(`missing update feed: ${feedFile}`);
	}
	for (const fileName of [...SOURCE_OFFER_FILES, ...nativeFfmpegEvidenceFiles]) {
		if (!seen.has(fileName)) throw new Error(`missing LGPL release evidence: ${fileName}`);
	}

	const manifest = buildReleaseManifest([...seen], version, UPDATE_BASE_URL, targets);
	const immutableFiles = [...seen].filter((fileName) => !FEED_FILES.has(fileName)).sort();
	manifest.artifacts = Object.fromEntries(
		immutableFiles.map((fileName) => {
			const filePath = path.join(outputRoot, fileName);
			return [fileName, { size: statSync(filePath).size, sha512: sha512File(filePath) }];
		}),
	);
	validateElectronUpdateFeeds(
		Object.fromEntries(
			feedFiles.map((feedName) => [
				feedName,
				fs.readFileSync(path.join(outputRoot, feedName), "utf8"),
			]),
		),
		manifest.artifacts,
		feedFiles,
	);
	if (sourceSha !== undefined) {
		if (!SOURCE_SHA.test(sourceSha)) throw new Error("release source SHA must be 40 hex digits");
		manifest.source = { commit: sourceSha.toLowerCase() };
	}
	writeFileSync(path.join(outputRoot, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const targetsIndex = args.indexOf("--targets");
	const targets =
		targetsIndex === -1 ? RELEASE_TARGETS : (args.splice(targetsIndex, 2)[1] ?? "").split(",");
	const [sourceRoot, version, outputRoot] = args;
	if (!sourceRoot || !version || !outputRoot) {
		console.error(
			"usage: stage-update-release.mjs <artifact-root> <version> <output-dir> [--targets darwin-arm64,...]",
		);
		process.exit(2);
	}
	stageUpdateRelease(sourceRoot, version, outputRoot, process.env.KLIPPT_SOURCE_SHA, targets);
	console.info(`Staged Klippt ${version} update files in ${outputRoot}`);
}

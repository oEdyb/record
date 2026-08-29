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
import { ELECTRON_FEED_FILES, validateElectronUpdateFeeds } from "./update-feed-integrity.mjs";
import { loadWebDemuxerPolicy, sourceOfferFileNames } from "./web-demuxer-source.mjs";

const UPDATE_BASE_URL = "https://updates.dyberg.co/klippt";
const FEED_FILES = new Set(ELECTRON_FEED_FILES);
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const WEB_DEMUXER_POLICY = loadWebDemuxerPolicy();
const SOURCE_OFFER_FILES = new Set(sourceOfferFileNames(WEB_DEMUXER_POLICY));
const RELEASE_FFMPEG_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const NATIVE_FFMPEG_EVIDENCE_FILES = new Set(
	RELEASE_FFMPEG_TARGETS.flatMap(nativeFfmpegEvidenceFileNames),
);

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

export function buildReleaseManifest(fileNames, version, baseUrl = UPDATE_BASE_URL) {
	const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const manifest = {
		version,
		downloads: {
			"darwin-arm64": matchesSingle(
				fileNames,
				new RegExp(`^Klippt-macOS-Apple-Silicon-${escapedVersion}\\.dmg$`),
				"Apple Silicon DMG",
			),
			"darwin-x64": matchesSingle(
				fileNames,
				new RegExp(`^Klippt-macOS-Intel-${escapedVersion}\\.dmg$`),
				"Intel DMG",
			),
			"win32-x64": matchesSingle(
				fileNames,
				new RegExp(`^Klippt\\.Setup\\.${escapedVersion}\\.exe$`),
				"Windows installer",
			),
			"linux-x64": matchesSingle(
				fileNames,
				new RegExp(`^Klippt-Linux-${escapedVersion}\\.AppImage$`),
				"Linux AppImage",
			),
		},
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

export function stageUpdateRelease(sourceRoot, version, outputRoot, sourceSha) {
	const sourceFiles = listFiles(sourceRoot).filter((file) => isUpdateArtifact(path.basename(file)));
	const seen = new Set();
	mkdirSync(outputRoot, { recursive: true });

	for (const sourceFile of sourceFiles) {
		const fileName = path.basename(sourceFile);
		if (seen.has(fileName)) throw new Error(`duplicate release filename: ${fileName}`);
		seen.add(fileName);
		copyFileSync(sourceFile, path.join(outputRoot, fileName));
	}

	for (const feedFile of FEED_FILES) {
		if (!seen.has(feedFile)) throw new Error(`missing update feed: ${feedFile}`);
	}
	for (const fileName of [...SOURCE_OFFER_FILES, ...NATIVE_FFMPEG_EVIDENCE_FILES]) {
		if (!seen.has(fileName)) throw new Error(`missing LGPL release evidence: ${fileName}`);
	}

	const manifest = buildReleaseManifest([...seen], version);
	const immutableFiles = [...seen].filter((fileName) => !FEED_FILES.has(fileName)).sort();
	manifest.artifacts = Object.fromEntries(
		immutableFiles.map((fileName) => {
			const filePath = path.join(outputRoot, fileName);
			return [fileName, { size: statSync(filePath).size, sha512: sha512File(filePath) }];
		}),
	);
	validateElectronUpdateFeeds(
		Object.fromEntries(
			ELECTRON_FEED_FILES.map((feedName) => [
				feedName,
				fs.readFileSync(path.join(outputRoot, feedName), "utf8"),
			]),
		),
		manifest.artifacts,
	);
	if (sourceSha !== undefined) {
		if (!SOURCE_SHA.test(sourceSha)) throw new Error("release source SHA must be 40 hex digits");
		manifest.source = { commit: sourceSha.toLowerCase() };
	}
	writeFileSync(path.join(outputRoot, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [sourceRoot, version, outputRoot] = process.argv.slice(2);
	if (!sourceRoot || !version || !outputRoot) {
		console.error("usage: stage-update-release.mjs <artifact-root> <version> <output-dir>");
		process.exit(2);
	}
	stageUpdateRelease(sourceRoot, version, outputRoot, process.env.KLIPPT_SOURCE_SHA);
	console.info(`Staged Klippt ${version} update files in ${outputRoot}`);
}

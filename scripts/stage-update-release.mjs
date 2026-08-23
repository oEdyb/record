#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const UPDATE_BASE_URL = "https://updates.dyberg.co/klippt";
const FEED_FILES = new Set(["latest.yml", "latest-mac.yml", "latest-linux.yml"]);

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
		FEED_FILES.has(fileName) || /\.(?:dmg|zip|exe|blockmap|AppImage|deb|rpm|pacman)$/.test(fileName)
	);
}

export function stageUpdateRelease(sourceRoot, version, outputRoot) {
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

	const manifest = buildReleaseManifest([...seen], version);
	writeFileSync(path.join(outputRoot, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [sourceRoot, version, outputRoot] = process.argv.slice(2);
	if (!sourceRoot || !version || !outputRoot) {
		console.error("usage: stage-update-release.mjs <artifact-root> <version> <output-dir>");
		process.exit(2);
	}
	stageUpdateRelease(sourceRoot, version, outputRoot);
	console.info(`Staged Klippt ${version} update files in ${outputRoot}`);
}

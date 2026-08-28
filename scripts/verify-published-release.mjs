#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ELECTRON_FEED_FILES, validateElectronUpdateFeeds } from "./update-feed-integrity.mjs";

const FEED_FILES = new Set(["latest.yml", "latest-mac.yml", "latest-linux.yml", "latest.json"]);

async function hashLocalFile(filePath) {
	const info = await stat(filePath);
	const hash = createHash("sha512");
	await new Promise((resolve, reject) => {
		const stream = fs.createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return { size: info.size, sha512: hash.digest("base64") };
}

async function fetchIntegrity(url, timeoutMs) {
	const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok || !response.body)
		throw new Error(`Public release fetch failed (${response.status})`);
	const hash = createHash("sha512");
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		hash.update(chunk);
	}
	return { size, sha512: hash.digest("base64") };
}

async function fetchWithRetry(url, timeoutMs, attempts = 4) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await fetchIntegrity(url, timeoutMs);
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
		}
	}
	throw lastError;
}

async function verifyFile(root, baseUrl, fileName, timeoutMs) {
	const local = await hashLocalFile(path.join(root, fileName));
	const url = new URL(encodeURIComponent(fileName), `${baseUrl.replace(/\/$/, "")}/`);
	url.searchParams.set("verify", local.sha512.slice(0, 16));
	const remote = await fetchWithRetry(url, timeoutMs);
	if (remote.size !== local.size || remote.sha512 !== local.sha512) {
		throw new Error(
			`Public release mismatch for ${fileName}: local ${local.size}/${local.sha512}, remote ${remote.size}/${remote.sha512}`,
		);
	}
	return local;
}

export async function verifyPublishedRelease({
	root,
	baseUrl,
	immutableOnly = false,
	expectedSourceSha,
	timeoutMs = 120_000,
}) {
	const allFiles = (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	const files = immutableOnly ? allFiles.filter((name) => !FEED_FILES.has(name)) : allFiles;
	if (files.length === 0) throw new Error("No staged release files to verify");

	if (!immutableOnly) {
		const latest = JSON.parse(await fs.promises.readFile(path.join(root, "latest.json"), "utf8"));
		if (expectedSourceSha && latest.source?.commit !== expectedSourceSha.toLowerCase()) {
			throw new Error("latest.json source commit does not match the release source");
		}
		const immutable = allFiles.filter((name) => !FEED_FILES.has(name));
		if (JSON.stringify(Object.keys(latest.artifacts ?? {}).sort()) !== JSON.stringify(immutable)) {
			throw new Error("latest.json does not describe every immutable release artifact");
		}
		for (const fileName of immutable) {
			const local = await hashLocalFile(path.join(root, fileName));
			const declared = latest.artifacts[fileName];
			if (declared?.size !== local.size || declared?.sha512 !== local.sha512) {
				throw new Error(`latest.json integrity mismatch for ${fileName}`);
			}
		}
		validateElectronUpdateFeeds(
			Object.fromEntries(
				await Promise.all(
					ELECTRON_FEED_FILES.map(async (feedName) => [
						feedName,
						await fs.promises.readFile(path.join(root, feedName), "utf8"),
					]),
				),
			),
			latest.artifacts,
		);
		for (const downloadUrl of Object.values(latest.downloads ?? {})) {
			const parsed = new URL(downloadUrl);
			const fileName = decodeURIComponent(path.posix.basename(parsed.pathname));
			if (!latest.artifacts[fileName]) {
				throw new Error(`latest.json download is not integrity-bound: ${fileName}`);
			}
		}
	}

	const results = {};
	let cursor = 0;
	const workers = Array.from({ length: Math.min(2, files.length) }, async () => {
		while (cursor < files.length) {
			const fileName = files[cursor];
			cursor += 1;
			results[fileName] = await verifyFile(root, baseUrl, fileName, timeoutMs);
		}
	});
	await Promise.all(workers);
	return results;
}

function parseArguments(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--immutable-only") options.immutableOnly = true;
		else if (arg === "--root") options.root = path.resolve(args[++index]);
		else if (arg === "--base-url") options.baseUrl = args[++index];
		else if (arg === "--source-sha") options.expectedSourceSha = args[++index];
		else if (arg === "--timeout-ms") options.timeoutMs = Number(args[++index]);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.root || !options.baseUrl) {
		throw new Error("usage: verify-published-release.mjs --root DIR --base-url URL");
	}
	return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await verifyPublishedRelease(parseArguments(process.argv.slice(2)));
	console.log(`Verified ${Object.keys(result).length} public release files by size and SHA-512`);
}

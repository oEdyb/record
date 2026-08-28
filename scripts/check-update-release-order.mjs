#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://updates.dyberg.co/klippt";
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function parseStableVersion(version) {
	const match = STABLE_VERSION.exec(version);
	if (!match) throw new Error(`release version must be stable SemVer: ${version}`);
	return match.slice(1).map(Number);
}

export function compareStableVersions(left, right) {
	const leftParts = parseStableVersion(left);
	const rightParts = parseStableVersion(right);
	for (let index = 0; index < leftParts.length; index += 1) {
		if (leftParts[index] !== rightParts[index]) {
			return leftParts[index] > rightParts[index] ? 1 : -1;
		}
	}
	return 0;
}

export function assertReleaseOrder(candidateVersion, sourceSha, publishedManifest) {
	parseStableVersion(candidateVersion);
	if (!SOURCE_SHA.test(sourceSha))
		throw new Error("release source SHA must be 40 lowercase hex digits");
	if (!publishedManifest || typeof publishedManifest !== "object") {
		throw new Error("published latest.json must be an object");
	}
	const publishedVersion = publishedManifest.version;
	if (typeof publishedVersion !== "string") {
		throw new Error("published latest.json has no version");
	}

	const comparison = compareStableVersions(candidateVersion, publishedVersion);
	if (comparison < 0) {
		throw new Error(
			`refusing to replace Klippt ${publishedVersion} with older release ${candidateVersion}`,
		);
	}
	if (comparison === 0) {
		const publishedSource = publishedManifest.source?.commit;
		if (publishedSource !== sourceSha) {
			throw new Error(
				`release ${candidateVersion} is already published from a different or unknown source commit`,
			);
		}
		return "exact-retry";
	}
	return "newer";
}

export async function checkPublicReleaseOrder({
	version,
	sourceSha,
	baseUrl = DEFAULT_BASE_URL,
	fetchImpl = fetch,
}) {
	parseStableVersion(version);
	if (!SOURCE_SHA.test(sourceSha))
		throw new Error("release source SHA must be 40 lowercase hex digits");
	const manifestUrl = new URL("latest.json", `${baseUrl.replace(/\/$/, "")}/`);
	manifestUrl.searchParams.set("release-order", `${version}-${sourceSha.slice(0, 12)}`);

	const response = await fetchImpl(manifestUrl, {
		cache: "no-store",
		headers: { "cache-control": "no-cache" },
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 404) return "first-release";
	if (!response.ok) {
		throw new Error(`cannot verify the current public release: HTTP ${response.status}`);
	}
	const body = await response.text();
	if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) {
		throw new Error("published latest.json exceeds the 1 MiB safety limit");
	}
	let manifest;
	try {
		manifest = JSON.parse(body);
	} catch {
		throw new Error("published latest.json is not valid JSON");
	}
	return assertReleaseOrder(version, sourceSha, manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const version = process.env.KLIPPT_RELEASE_VERSION;
	const sourceSha = process.env.KLIPPT_SOURCE_SHA;
	if (!version || !sourceSha) {
		console.error("KLIPPT_RELEASE_VERSION and KLIPPT_SOURCE_SHA are required");
		process.exit(2);
	}
	const result = await checkPublicReleaseOrder({
		version,
		sourceSha,
		baseUrl: process.env.KLIPPT_UPDATE_BASE_URL,
	});
	console.info(`Release order accepted: ${result}`);
}

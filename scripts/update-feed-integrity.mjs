import path from "node:path";
import { parse } from "yaml";

export const ELECTRON_FEED_FILES = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];
export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const FEED_FOR_PLATFORM = {
	darwin: "latest-mac.yml",
	linux: "latest-linux.yml",
	win32: "latest.yml",
};

/** The electron-updater feeds a release for these targets must publish, in ELECTRON_FEED_FILES order. */
export function feedFilesForTargets(targets) {
	if (targets.length === 0) throw new Error("a release needs at least one target");
	const feeds = new Set(
		targets.map((target) => {
			if (!RELEASE_TARGETS.includes(target))
				throw new Error(`unsupported release target: ${target}`);
			return FEED_FOR_PLATFORM[target.split("-")[0]];
		}),
	);
	return ELECTRON_FEED_FILES.filter((feedName) => feeds.has(feedName));
}
const SHA512_BYTES = 64;

function feedArtifactName(value, label) {
	if (typeof value !== "string" || !value || value !== value.trim()) {
		throw new Error(`${label} needs a nonempty artifact URL`);
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || /[?#\\]/.test(value)) {
		throw new Error(`${label} must reference one staged artifact basename`);
	}
	let decoded;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		throw new Error(`${label} has invalid URL encoding`);
	}
	if (!decoded || decoded === "." || decoded === ".." || path.posix.basename(decoded) !== decoded) {
		throw new Error(`${label} escapes the staged release directory`);
	}
	return decoded;
}

function validBase64Sha512(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
	try {
		return Buffer.from(value, "base64").length === SHA512_BYTES;
	} catch {
		return false;
	}
}

function validateDescriptor(feedName, descriptor, artifacts, label) {
	const fileName = feedArtifactName(descriptor?.url, label);
	const artifact = artifacts[fileName];
	if (!artifact) throw new Error(`${feedName} references a missing artifact: ${fileName}`);
	if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
		throw new Error(`${feedName} has no valid size for ${fileName}`);
	}
	if (!validBase64Sha512(descriptor.sha512)) {
		throw new Error(`${feedName} has no valid SHA-512 for ${fileName}`);
	}
	if (descriptor.size !== artifact.size || descriptor.sha512 !== artifact.sha512) {
		throw new Error(`${feedName} integrity mismatch for ${fileName}`);
	}
	return fileName;
}

export function validateElectronUpdateFeeds(
	feedContents,
	artifacts,
	feedNames = ELECTRON_FEED_FILES,
) {
	for (const feedName of feedNames) {
		let feed;
		try {
			feed = parse(feedContents[feedName]);
		} catch (error) {
			throw new Error(`${feedName} is not valid YAML: ${error.message}`);
		}
		if (
			!feed ||
			typeof feed !== "object" ||
			!Array.isArray(feed.files) ||
			feed.files.length === 0
		) {
			throw new Error(`${feedName} must contain a nonempty files list`);
		}
		const referenced = feed.files.map((descriptor, index) =>
			validateDescriptor(feedName, descriptor, artifacts, `${feedName} files[${index}]`),
		);
		if (new Set(referenced).size !== referenced.length) {
			throw new Error(`${feedName} contains duplicate artifact URLs`);
		}
		if (feed.path !== undefined) {
			const legacyName = feedArtifactName(feed.path, `${feedName} path`);
			if (!referenced.includes(legacyName)) {
				throw new Error(`${feedName} legacy path is absent from files: ${legacyName}`);
			}
			if (feed.sha512 !== artifacts[legacyName]?.sha512) {
				throw new Error(`${feedName} legacy SHA-512 mismatch for ${legacyName}`);
			}
		}
		if (feedName === "latest-mac.yml") {
			const hasX64 = referenced.some((name) => /(?:^|[-_.])x64(?:[-_.]|$)/i.test(name));
			const arm64Count = referenced.filter((name) =>
				/(?:^|[-_.])arm64(?:[-_.]|$)/i.test(name),
			).length;
			if (arm64Count !== 1 || referenced.length !== (hasX64 ? 2 : 1)) {
				throw new Error(
					"latest-mac.yml must bind exactly one arm64 update archive and at most one x64 archive",
				);
			}
		}
	}
}

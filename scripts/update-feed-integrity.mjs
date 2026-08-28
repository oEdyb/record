import path from "node:path";
import { parse } from "yaml";

export const ELECTRON_FEED_FILES = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];
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

export function validateElectronUpdateFeeds(feedContents, artifacts) {
	for (const feedName of ELECTRON_FEED_FILES) {
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
			const hasArm64 = referenced.some((name) => /(?:^|[-_.])arm64(?:[-_.]|$)/i.test(name));
			const hasX64 = referenced.some((name) => /(?:^|[-_.])x64(?:[-_.]|$)/i.test(name));
			if (referenced.length !== 2 || !hasArm64 || !hasX64) {
				throw new Error("latest-mac.yml must bind exactly one arm64 and one x64 update archive");
			}
		}
	}
}

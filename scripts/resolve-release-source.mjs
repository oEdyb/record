#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?$/;
const RELEASE_SIGNER = "131144165+oEdyb@users.noreply.github.com";

function git(root, args, options = {}) {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	}).trim();
}

function resolveCommit(root, revision) {
	const resolved = git(root, ["rev-parse", `${revision}^{commit}`]);
	if (!SHA.test(resolved)) throw new Error(`Invalid commit resolved from ${revision}`);
	return resolved;
}

export function verifyReleaseTag(root, tag, publicKey) {
	if (!RELEASE_TAG.test(tag)) {
		throw new Error(`Release tag must look like v1.5.0 or v1.5.0-rc.1; got '${tag}'`);
	}
	const reference = `refs/tags/${tag}`;
	if (git(root, ["cat-file", "-t", reference]) !== "tag") {
		throw new Error(`Release tag ${tag} must be an annotated signed tag`);
	}
	const tagObject = git(root, ["cat-file", "tag", reference]);
	const tagger = tagObject.split("\n").find((line) => line.startsWith("tagger ")) ?? "";
	if (!tagger.includes(`<${RELEASE_SIGNER}>`)) {
		throw new Error(`Release tag ${tag} must use the Klippt release signer identity`);
	}

	const normalizedPublicKey = publicKey?.trim() ?? "";
	if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(normalizedPublicKey)) {
		throw new Error("External release public key must contain one exact Ed25519 key");
	}
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-release-tag-"));
	try {
		const allowedSignersPath = path.join(temporaryDirectory, "allowed_signers");
		fs.writeFileSync(
			allowedSignersPath,
			`${RELEASE_SIGNER} namespaces="git" ${normalizedPublicKey}\n`,
			{ mode: 0o600 },
		);
		git(root, [
			"-c",
			"gpg.format=ssh",
			"-c",
			`gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
			"verify-tag",
			tag,
		]);
	} catch {
		throw new Error(`Release tag ${tag} does not have a valid Klippt signature`);
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	return resolveCommit(root, reference);
}

export function resolveReleaseSource(options, root = DEFAULT_ROOT) {
	const eventSha = options.eventSha?.toLowerCase() ?? "";
	if (!SHA.test(eventSha)) throw new Error(`Invalid event source SHA: ${options.eventSha ?? ""}`);

	if (options.eventName === "push") {
		if (options.refType !== "tag") throw new Error("Release push must use a tag ref");
		const sourceSha = verifyReleaseTag(root, options.refName, options.releasePublicKey);
		if (sourceSha !== eventSha) {
			throw new Error(`Tag ${options.refName} resolves to ${sourceSha}, not event SHA ${eventSha}`);
		}
		return { sourceSha, releaseTag: options.refName, isRelease: true };
	}

	if (options.eventName !== "workflow_dispatch") {
		throw new Error(`Unsupported build event: ${options.eventName}`);
	}
	const requestedTag = options.releaseTag?.trim() ?? "";
	if (requestedTag === "") {
		return { sourceSha: eventSha, releaseTag: "", isRelease: false };
	}
	if (options.refType !== "tag" || options.refName !== requestedTag) {
		throw new Error(
			`Select the existing tag '${requestedTag}' as the workflow ref; the selected ref is '${options.refName}'`,
		);
	}
	const sourceSha = verifyReleaseTag(root, requestedTag, options.releasePublicKey);
	if (sourceSha !== eventSha) {
		throw new Error(`Tag ${requestedTag} resolves to ${sourceSha}, not event SHA ${eventSha}`);
	}
	return { sourceSha, releaseTag: requestedTag, isRelease: true };
}

function appendOutput(file, result) {
	fs.appendFileSync(
		file,
		`source_sha=${result.sourceSha}\nrelease_tag=${result.releaseTag}\nis_release=${result.isRelease}\n`,
	);
}

const isMain =
	process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const result = resolveReleaseSource({
		eventName: process.env.GITHUB_EVENT_NAME,
		eventSha: process.env.GITHUB_SHA,
		refType: process.env.GITHUB_REF_TYPE,
		refName: process.env.GITHUB_REF_NAME,
		releaseTag: process.env.INPUT_RELEASE_TAG,
		releasePublicKey: process.env.KLIPPT_RELEASE_PUBLIC_KEY,
	});
	if (process.env.GITHUB_OUTPUT) appendOutput(process.env.GITHUB_OUTPUT, result);
	console.log(JSON.stringify(result));
}

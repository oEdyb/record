import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReleaseSource } from "./resolve-release-source.mjs";

const roots = [];

function command(root, executable, args) {
	return execFileSync(executable, args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "klippt-release-source-"));
	roots.push(root);
	mkdirSync(path.join(root, "supply-chain"), { recursive: true });
	command(root, "git", ["init", "-q"]);
	command(root, "git", ["config", "user.name", "Olle Dyberg"]);
	command(root, "git", ["config", "user.email", "131144165+oEdyb@users.noreply.github.com"]);
	const keyPath = path.join(root, "release-key");
	command(root, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
	const publicKey = readFileSync(`${keyPath}.pub`, "utf8")
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.join(" ");
	writeFileSync(path.join(root, "supply-chain", "dependency-approval-key.pub"), `${publicKey}\n`);
	writeFileSync(path.join(root, "package.json"), '{"version":"2.0.0"}\n');
	command(root, "git", ["add", "."]);
	command(root, "git", ["commit", "-q", "-m", "release source"]);
	const sha = command(root, "git", ["rev-parse", "HEAD"]);
	return { root, keyPath, publicKey, sha };
}

function signTag(root, keyPath, tag = "v2.0.0") {
	command(root, "git", [
		"-c",
		"gpg.format=ssh",
		"-c",
		`user.signingkey=${keyPath}`,
		"tag",
		"-s",
		tag,
		"-m",
		`Klippt ${tag}`,
	]);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("release source resolution", () => {
	it("binds a tag push to its signed commit", () => {
		const { root, keyPath, publicKey, sha } = fixture();
		signTag(root, keyPath);
		expect(
			resolveReleaseSource(
				{
					eventName: "push",
					eventSha: sha,
					refType: "tag",
					refName: "v2.0.0",
					releasePublicKey: publicKey,
				},
				root,
			),
		).toEqual({ sourceSha: sha, releaseTag: "v2.0.0", isRelease: true });
	});

	it("allows an artifact-only manual build at the selected commit", () => {
		const { root, sha } = fixture();
		expect(
			resolveReleaseSource(
				{
					eventName: "workflow_dispatch",
					eventSha: sha,
					refType: "branch",
					refName: "main",
					releaseTag: "",
				},
				root,
			),
		).toEqual({ sourceSha: sha, releaseTag: "", isRelease: false });
	});

	it("rejects a manual release when the selected ref is not the named tag", () => {
		const { root, keyPath, publicKey, sha } = fixture();
		signTag(root, keyPath);
		expect(() =>
			resolveReleaseSource(
				{
					eventName: "workflow_dispatch",
					eventSha: sha,
					refType: "branch",
					refName: "main",
					releaseTag: "v2.0.0",
					releasePublicKey: publicKey,
				},
				root,
			),
		).toThrow(/Select the existing tag/);
	});

	it("rejects an unsigned release tag", () => {
		const { root, publicKey, sha } = fixture();
		command(root, "git", ["tag", "-a", "v2.0.0", "-m", "unsigned"]);
		expect(() =>
			resolveReleaseSource(
				{
					eventName: "push",
					eventSha: sha,
					refType: "tag",
					refName: "v2.0.0",
					releasePublicKey: publicKey,
				},
				root,
			),
		).toThrow(/valid Klippt signature/);
	});

	it("rejects a tag signed by another key", () => {
		const { root, publicKey, sha } = fixture();
		const otherKey = path.join(root, "other-key");
		command(root, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", otherKey]);
		signTag(root, otherKey);
		expect(() =>
			resolveReleaseSource(
				{
					eventName: "push",
					eventSha: sha,
					refType: "tag",
					refName: "v2.0.0",
					releasePublicKey: publicKey,
				},
				root,
			),
		).toThrow(/valid Klippt signature/);
	});

	it("rejects a signed tag when the external trust key is missing", () => {
		const { root, keyPath, sha } = fixture();
		signTag(root, keyPath);
		expect(() =>
			resolveReleaseSource(
				{ eventName: "push", eventSha: sha, refType: "tag", refName: "v2.0.0" },
				root,
			),
		).toThrow(/External release public key/);
	});
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyApprovedDependencies } from "./check-approved-dependencies.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

async function writeSignedPolicy(root, files, signingKeyPath = path.join(root, "approval-key")) {
	const policyPath = path.join(root, "supply-chain", "approved-dependency-inputs.json");
	const inputs = Object.fromEntries(
		Object.entries(files).map(([relativePath, contents]) => [
			relativePath,
			createHash("sha256").update(contents).digest("hex"),
		]),
	);
	await writeFile(
		policyPath,
		`${JSON.stringify({ schemaVersion: 1, reviewedAt: "2026-08-28", inputs }, null, "\t")}\n`,
	);
	if (!signingKeyPath.startsWith(root)) {
		throw new Error("Test signing key must stay inside its temporary root");
	}
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKeyPath]);
	const publicKey = (await readFile(`${signingKeyPath}.pub`, "utf8"))
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.join(" ");
	await writeFile(path.join(root, "supply-chain", "dependency-approval-key.pub"), `${publicKey}\n`);
	execFileSync(
		"ssh-keygen",
		["-Y", "sign", "-f", signingKeyPath, "-n", "klippt-dependency-approval", policyPath],
		{ stdio: "ignore" },
	);
	return policyPath;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("approved dependency inputs", () => {
	it("matches every current npm, Cargo, CMake, Swift, FFmpeg, and model input", () => {
		expect(verifyApprovedDependencies(REPO_ROOT)).toEqual({
			count: 22,
			reviewedAt: "2026-09-01",
		});
	});

	it("rejects a dependency change without a reviewed hash", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "klippt-approved-dependencies-"));
		temporaryDirectories.push(root);
		const requiredDirectories = [
			"crates",
			"electron/native/parakeet-stt",
			"electron/native/screencapturekit",
			"electron/native/whisper-stt",
			"electron/stt",
			"scripts",
			"supply-chain",
			"website",
		];
		await Promise.all(
			requiredDirectories.map((directory) =>
				mkdir(path.join(root, directory), { recursive: true }),
			),
		);
		const files = {
			"crates/Cargo.lock": "lock",
			"crates/Cargo.toml": "manifest",
			"electron/native/parakeet-stt/Package.resolved": "resolved",
			"electron/native/parakeet-stt/Package.swift": "swift",
			"electron/native/screencapturekit/Package.swift": "capture",
			"electron/native/whisper-stt/CMakeLists.txt": "cmake",
			"electron/stt/modelManager.ts": "models",
			"package-lock.json": "desktop",
			"scripts/ffmpeg-pins.mjs": "ffmpeg",
			"website/package-lock.json": "website",
		};
		for (const [relativePath, contents] of Object.entries(files)) {
			await writeFile(path.join(root, relativePath), contents);
		}
		await writeSignedPolicy(root, files);
		expect(() => verifyApprovedDependencies(root)).not.toThrow();
		await writeFile(path.join(root, "package-lock.json"), "changed");
		expect(() => verifyApprovedDependencies(root)).toThrow(/changed without dependency approval/);
	});

	it("rejects a new nested npm graph that is missing from the approval policy", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "klippt-approved-npm-"));
		temporaryDirectories.push(root);
		await Promise.all(
			["electron/stt", "scripts", "supply-chain", "tools/new-helper"].map((directory) =>
				mkdir(path.join(root, directory), { recursive: true }),
			),
		);
		const files = {
			"electron/stt/modelManager.ts": "models",
			"package-lock.json": "desktop",
			"scripts/ffmpeg-pins.mjs": "ffmpeg",
		};
		for (const [relativePath, contents] of Object.entries(files)) {
			await writeFile(path.join(root, relativePath), contents);
		}
		await writeSignedPolicy(root, files);
		expect(() => verifyApprovedDependencies(root)).not.toThrow();

		await writeFile(path.join(root, "tools/new-helper/package-lock.json"), "nested");
		expect(() => verifyApprovedDependencies(root)).toThrow(/approval policy is stale/);
	});

	it("rejects npm shrinkwrap files that could override an approved lockfile", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "klippt-approved-shrinkwrap-"));
		temporaryDirectories.push(root);
		await Promise.all(
			["electron/stt", "scripts", "supply-chain"].map((directory) =>
				mkdir(path.join(root, directory), { recursive: true }),
			),
		);
		await writeFile(path.join(root, "npm-shrinkwrap.json"), "{}");
		expect(() => verifyApprovedDependencies(root)).toThrow(/npm-shrinkwrap\.json is not allowed/);
	});

	it("rejects a changed approval baseline", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "klippt-approval-tamper-"));
		temporaryDirectories.push(root);
		await Promise.all(
			["electron/stt", "scripts", "supply-chain"].map((directory) =>
				mkdir(path.join(root, directory), { recursive: true }),
			),
		);
		const files = {
			"electron/stt/modelManager.ts": "models",
			"package-lock.json": "desktop",
			"scripts/ffmpeg-pins.mjs": "ffmpeg",
		};
		for (const [relativePath, contents] of Object.entries(files)) {
			await writeFile(path.join(root, relativePath), contents);
		}
		const policyPath = await writeSignedPolicy(root, files);
		await writeFile(policyPath, `${await readFile(policyPath, "utf8")} `);
		expect(() => verifyApprovedDependencies(root)).toThrow(/approval signature is invalid/);
	});

	it("rejects a signature from a different key", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "klippt-approval-key-"));
		temporaryDirectories.push(root);
		await Promise.all(
			["electron/stt", "scripts", "supply-chain"].map((directory) =>
				mkdir(path.join(root, directory), { recursive: true }),
			),
		);
		const files = {
			"electron/stt/modelManager.ts": "models",
			"package-lock.json": "desktop",
			"scripts/ffmpeg-pins.mjs": "ffmpeg",
		};
		for (const [relativePath, contents] of Object.entries(files)) {
			await writeFile(path.join(root, relativePath), contents);
		}
		await writeSignedPolicy(root, files);
		const wrongKeyPath = path.join(root, "wrong-key");
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", wrongKeyPath]);
		const wrongPublicKey = (await readFile(`${wrongKeyPath}.pub`, "utf8"))
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.join(" ");
		await writeFile(
			path.join(root, "supply-chain", "dependency-approval-key.pub"),
			`${wrongPublicKey}\n`,
		);
		expect(() => verifyApprovedDependencies(root)).toThrow(/approval signature is invalid/);
	});
});

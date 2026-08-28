#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.log("Skipping Clean Voice helper build: the first backend is macOS-only.");
	process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "electron", "native", "clean-voice");
const manifest = path.join(packageDir, "Cargo.toml");
const targetDir = path.join(packageDir, "build", "cargo");
const helperName = "klippt-clean-voice";
const engineCommit = "b0fa238a331fb5cc39c5555d3538008dd88c0aef";
const modelSha256 = "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	return result;
}

function verifyPinnedModel() {
	const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
	const checkouts = path.join(cargoHome, "git", "checkouts");
	const revisions = fs
		.readdirSync(checkouts, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("deepfilternet-"))
		.flatMap((family) => {
			const familyPath = path.join(checkouts, family.name);
			return fs
				.readdirSync(familyPath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(familyPath, entry.name));
		});
	let matches = 0;
	for (const revision of revisions) {
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: revision, encoding: "utf8" });
		if (head.status !== 0 || head.stdout.trim() !== engineCommit) continue;
		matches += 1;
		const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
			cwd: revision,
			encoding: "utf8",
		});
		if (status.status !== 0 || status.stdout.trim()) {
			throw new Error(`Pinned DeepFilterNet checkout is dirty: ${revision}`);
		}
		const model = path.join(revision, "models", "DeepFilterNet3_onnx.tar.gz");
		const actual = createHash("sha256").update(fs.readFileSync(model)).digest("hex");
		if (actual !== modelSha256) {
			throw new Error(`DeepFilterNet3 model hash mismatch: expected ${modelSha256}, got ${actual}`);
		}
	}
	if (matches === 0) {
		throw new Error(`Cargo fetched no DeepFilterNet checkout at ${engineCommit}`);
	}
}

function normalizeArch(value) {
	if (value === "x64" || value === "x86_64") {
		return { triple: "x86_64-apple-darwin", tag: "darwin-x64" };
	}
	if (value === "arm64" || value === "aarch64") {
		return { triple: "aarch64-apple-darwin", tag: "darwin-arm64" };
	}
	throw new Error(`Unsupported Clean Voice architecture: ${value}`);
}

const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const archs = (process.env.KLIPPT_CLEAN_VOICE_ARCHS ?? hostArch)
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean)
	.map(normalizeArch)
	.filter(({ tag }, index, values) => values.findIndex((value) => value.tag === tag) === index);

run("cargo", ["fetch", "--locked", "--manifest-path", manifest], {
	env: { ...process.env, CARGO_TARGET_DIR: targetDir },
});
verifyPinnedModel();

for (const { triple, tag } of archs) {
	run(
		"cargo",
		["build", "--locked", "--release", "--manifest-path", manifest, "--target", triple],
		{
			env: { ...process.env, CARGO_TARGET_DIR: targetDir },
		},
	);

	const built = path.join(targetDir, triple, "release", helperName);
	if (!fs.existsSync(built)) {
		console.error(`Clean Voice build completed but ${built} does not exist.`);
		process.exit(1);
	}
	const destination =
		(hostArch === "arm64" && tag === "darwin-arm64") || (hostArch === "x64" && tag === "darwin-x64")
			? path.join(packageDir, "build", helperName)
			: path.join(packageDir, "build", tag, helperName);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(built, destination);
	fs.chmodSync(destination, 0o755);
	console.log(`Built ${helperName} for ${tag}.`);
}

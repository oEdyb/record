#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	swiftBuildArguments,
	swiftBuildOutputDirectory,
	swiftBuiltExecutable,
} from "./swift-build-output.mjs";

if (process.platform !== "darwin") {
	console.log("Skipping Parakeet STT helper build: host platform is not macOS.");
	process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "electron", "native", "parakeet-stt");
const helperName = "klippt-parakeet-stt";
const hostSwiftArch = process.arch === "arm64" ? "arm64" : "x86_64";
const requestedArchs = (process.env.KLIPPT_PARAKEET_ARCHS ?? hostSwiftArch)
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean)
	.map((value) =>
		value === "x64" || value === "x86_64"
			? { swift: "x86_64", tag: "darwin-x64" }
			: { swift: "arm64", tag: "darwin-arm64" },
	);
const archs = requestedArchs.filter(({ swift }) => swift === "arm64");
if (archs.length === 0) {
	console.log("Skipping Parakeet STT helper build: Core ML backend is Apple Silicon only.");
}

for (const { swift, tag } of archs) {
	const buildPath = path.join(packageDir, "build", swift);
	const buildArgs = swiftBuildArguments({ packageDir, scratchDir: buildPath, swiftArch: swift });
	const result = spawnSync("swift", buildArgs, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);

	const source = swiftBuiltExecutable(
		swiftBuildOutputDirectory({ buildArgs, cwd: root }),
		helperName,
	);
	const destinationDir = path.join(root, "electron", "native", "bin", tag);
	fs.mkdirSync(destinationDir, { recursive: true });
	const destination = path.join(destinationDir, helperName);
	fs.copyFileSync(source, destination);
	fs.chmodSync(destination, 0o755);
	console.log(`Built ${helperName} -> ${destination}`);
}

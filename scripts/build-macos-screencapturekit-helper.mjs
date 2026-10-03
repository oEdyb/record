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
	console.log("Skipping macOS ScreenCaptureKit helper build: host platform is not macOS.");
	process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const helperName = "openscreen-screencapturekit-helper";
const cursorHelperName = "openscreen-macos-cursor-helper";
const packageDir = path.join(root, "electron", "native", "screencapturekit");
const buildDir = path.join(packageDir, "build");
const swiftBuildDir = path.join(buildDir, "swiftpm");
const localHelperPath = path.join(buildDir, helperName);
const localCursorHelperPath = path.join(buildDir, cursorHelperName);

// Build a separate single-arch binary per requested arch and place each in its own
// electron/native/bin/darwin-<arch> folder (the runtime resolves that folder by the running app's
// arch). No universal/fat binary. Defaults to the host arch for local builds; CI sets
// OPENSCREEN_MAC_HELPER_ARCHS per matrix entry (accepts arm64, x64, or x86_64).
function normalizeArch(value) {
	return value === "x64" || value === "x86_64"
		? { swift: "x86_64", tag: "darwin-x64" }
		: { swift: "arm64", tag: "darwin-arm64" };
}
const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
const archs = (process.env.OPENSCREEN_MAC_HELPER_ARCHS ?? hostArch)
	.split(",")
	.map((a) => a.trim())
	.filter(Boolean)
	.map(normalizeArch);

const xcodebuildVersion = spawnSync("xcodebuild", ["-version"], {
	cwd: root,
	encoding: "utf8",
});

if (xcodebuildVersion.status !== 0) {
	const message = `${xcodebuildVersion.stderr ?? ""}${xcodebuildVersion.stdout ?? ""}`.trim();
	console.error(
		[
			"Unable to build the macOS ScreenCaptureKit helper because full Xcode is not active.",
			"",
			message,
			"",
			"Install Xcode from the App Store or Apple Developer downloads, then run:",
			"  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer",
			"  sudo xcodebuild -license accept",
			"",
			"Command Line Tools alone may not include the Swift SDK/platform metadata required by SwiftPM.",
		].join("\n"),
	);
	process.exit(1);
}

fs.mkdirSync(buildDir, { recursive: true });

for (const { swift, tag } of archs) {
	const archBuildDir = path.join(swiftBuildDir, swift);
	const buildArgs = swiftBuildArguments({ packageDir, scratchDir: archBuildDir, swiftArch: swift });
	const result = spawnSync("swift", buildArgs, {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) {
		console.error(`Failed to start Swift build (${swift}): ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
	let outputDirectory;
	try {
		outputDirectory = swiftBuildOutputDirectory({ buildArgs, cwd: root });
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}

	const targetDir = path.join(root, "electron", "native", "bin", tag);
	fs.mkdirSync(targetDir, { recursive: true });

	for (const [name, localPath] of [
		[helperName, localHelperPath],
		[cursorHelperName, localCursorHelperPath],
	]) {
		let exe;
		try {
			exe = swiftBuiltExecutable(outputDirectory, name);
		} catch (error) {
			console.error(error.message);
			process.exit(1);
		}
		// Always place it in the arch's bin folder; mirror the host-arch build into the dev build
		// dir so `npm run dev` (candidate path #2) can spawn it.
		const dests = [path.join(targetDir, name)];
		if (swift === hostArch) dests.push(localPath);
		for (const dest of dests) {
			fs.copyFileSync(exe, dest);
			fs.chmodSync(dest, 0o755);
		}
	}
	console.log(`Built ${tag} helpers (${swift})`);
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helperTarget = [
	"\t\t.executableTarget(",
	'\t\t\tname: "OpenScreenScreenCaptureKitHelper",',
	'\t\t\tpath: "Sources/OpenScreenScreenCaptureKitHelper",',
	'\t\t\tlinkerSettings: embeddedInfoPlist("screencapturekit-helper")',
	"\t\t)",
].join("\n");
const packageTail = [
	"\t\t.executableTarget(",
	'\t\t\tname: "OpenScreenMacOSCursorHelper",',
	'\t\t\tpath: "Sources/OpenScreenMacOSCursorHelper",',
	'\t\t\tlinkerSettings: embeddedInfoPlist("cursor-helper")',
	"\t\t)",
	"\t]",
	")",
	"",
].join("\n");

export function isolatedCaptureTestManifest(baseManifest) {
	const required = [
		"// swift-tools-version: 5.9\n",
		"import PackageDescription\n",
		'\n\tname: "OpenScreenScreenCaptureKitHelper",\n',
		"\t\t.macOS(.v13)\n",
		helperTarget,
		packageTail,
	];
	if (
		typeof baseManifest !== "string" ||
		!baseManifest.startsWith(required[0]) ||
		!baseManifest.endsWith(packageTail) ||
		baseManifest.includes(".testTarget(") ||
		required.some((anchor) => baseManifest.split(anchor).length !== 2)
	) {
		throw new Error("Unsupported capture helper Package.swift; the approved base was not changed.");
	}
	const insertion = baseManifest.length - "\n\t]\n)\n".length;
	const testTarget = [
		"\t\t.testTarget(",
		'\t\t\tname: "OpenScreenScreenCaptureKitHelperTests",',
		'\t\t\tdependencies: ["OpenScreenScreenCaptureKitHelper"],',
		'\t\t\tpath: "Tests/OpenScreenScreenCaptureKitHelperTests"',
		"\t\t)",
		"\t]",
		")",
		"",
	].join("\n");
	return baseManifest.slice(0, insertion) + ",\n" + testTarget;
}

function killSwiftProcessGroup(child) {
	if (child.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// A process that has already exited may still have open output pipes.
		}
	}
	child.kill("SIGKILL");
}

function runSwift({ packageDir, scratchDir, signal, onOutput, spawnImpl }) {
	return new Promise((resolve, reject) => {
		const child = spawnImpl(
			"swift",
			["test", "--jobs", "2", "--package-path", packageDir, "--scratch-path", scratchDir],
			{ cwd: packageDir, detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		let failure;
		const abort = () => {
			failure ??= signal.reason ?? new Error("Swift capture tests canceled");
			killSwiftProcessGroup(child);
		};
		const output = (chunk) => {
			try {
				onOutput(chunk);
			} catch (error) {
				failure ??= error;
				killSwiftProcessGroup(child);
			}
		};
		child.stdout.on("data", output);
		child.stderr.on("data", output);
		child.on("error", (error) => {
			failure ??= error;
		});
		child.once("close", (code, exitSignal) => {
			signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(new Error("Swift capture tests failed (" + (exitSignal ?? "exit " + code) + ")."));
			else resolve();
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

export async function runCaptureHelperTests({
	packageDir,
	temporaryRoot = os.tmpdir(),
	signal,
	onOutput = (chunk) => process.stdout.write(chunk),
	spawnImpl = spawn,
}) {
	signal?.throwIfAborted();
	const manifest = isolatedCaptureTestManifest(
		fs.readFileSync(path.join(packageDir, "Package.swift"), "utf8"),
	);
	const isolatedPackage = fs.mkdtempSync(path.join(temporaryRoot, "klippt-capture-tests-"));
	try {
		fs.writeFileSync(path.join(isolatedPackage, "Package.swift"), manifest);
		for (const directory of ["Sources", "Tests", "Support"]) {
			fs.cpSync(path.join(packageDir, directory), path.join(isolatedPackage, directory), {
				recursive: true,
			});
		}
		await runSwift({
			packageDir: isolatedPackage,
			scratchDir: path.join(isolatedPackage, ".build"),
			signal,
			onOutput,
			spawnImpl,
		});
	} finally {
		fs.rmSync(isolatedPackage, { recursive: true, force: true });
	}
}

async function main() {
	if (process.platform !== "darwin") {
		console.log("Skipping macOS capture helper tests: host platform is not macOS.");
		return;
	}
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Swift capture tests canceled"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
		await runCaptureHelperTests({
			packageDir: path.join(root, "electron/native/screencapturekit"),
			signal: controller.signal,
		});
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}

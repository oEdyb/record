import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function swiftBuildArguments({ packageDir, scratchDir, swiftArch }) {
	return [
		"build",
		"-c",
		"release",
		"--arch",
		swiftArch,
		"--package-path",
		packageDir,
		"--scratch-path",
		scratchDir,
	];
}

export function swiftBuildOutputDirectory({ buildArgs, cwd, run = spawnSync }) {
	// Ask the same installed SwiftPM and build configuration that produced the
	// helper. Current Swift Build and older SwiftPM use different output layouts.
	const result = run("swift", [...buildArgs, "--show-bin-path"], { cwd, encoding: "utf8" });
	if (result.error)
		throw new Error(`Unable to resolve Swift build output: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(
			`Unable to resolve Swift build output: ${`${result.stderr ?? ""}${result.stdout ?? ""}`.trim()}`,
		);
	}
	const directory = result.stdout?.trim();
	if (!directory || !path.isAbsolute(directory) || /[\r\n]/.test(directory)) {
		throw new Error("Swift --show-bin-path did not return one absolute output directory.");
	}
	return directory;
}

export function swiftBuiltExecutable(directory, name) {
	const executable = path.join(directory, name);
	try {
		if (!fs.statSync(executable).isFile()) throw new Error("not a file");
		fs.accessSync(executable, fs.constants.X_OK);
	} catch {
		// An absent current product must fail the build; searching older scratch
		// directories can silently stage an executable from unrelated source.
		throw new Error(
			`Swift build completed but its current executable was not found: ${executable}`,
		);
	}
	return executable;
}

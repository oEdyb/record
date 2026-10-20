import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	swiftBuildArguments,
	swiftBuildOutputDirectory,
	swiftBuiltExecutable,
} from "./swift-build-output.mjs";

let directory;
const helperName = "klippt-screencapturekit-helper";

beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-swift-output-"));
});
afterEach(() => {
	fs.rmSync(directory, { recursive: true, force: true });
});

function executable(relativePath, contents) {
	const filename = path.join(directory, relativePath, helperName);
	fs.mkdirSync(path.dirname(filename), { recursive: true });
	fs.writeFileSync(filename, contents, { mode: 0o755 });
	return filename;
}

describe("Swift native build output", () => {
	it("uses the exact release architecture, package and scratch path for building and resolving output", () => {
		const buildArgs = swiftBuildArguments({
			packageDir: "/checkout/package",
			scratchDir: "/checkout/scratch",
			swiftArch: "arm64",
		});
		expect(buildArgs).toEqual([
			"build",
			"-c",
			"release",
			"--arch",
			"arm64",
			"--package-path",
			"/checkout/package",
			"--scratch-path",
			"/checkout/scratch",
		]);
		const run = vi.fn(() => ({ status: 0, stdout: `${directory}\n`, stderr: "" }));
		expect(swiftBuildOutputDirectory({ buildArgs, cwd: "/checkout", run })).toBe(directory);
		expect(run).toHaveBeenCalledWith("swift", [...buildArgs, "--show-bin-path"], {
			cwd: "/checkout",
			encoding: "utf8",
		});
	});

	it("selects the authoritative current product while stale legacy and dSYM executables coexist", () => {
		executable("arm64-apple-macosx/release", "stale September helper");
		executable("out/Products/Release/helper.dSYM/Contents/Resources/DWARF", "debug symbols");
		const current = executable("out/Products/Release", "current recording source");
		const binDirectory = path.dirname(current);
		const output = swiftBuildOutputDirectory({
			buildArgs: ["build", "-c", "release"],
			cwd: directory,
			run: () => ({ status: 0, stdout: `${binDirectory}\n`, stderr: "" }),
		});
		const selected = swiftBuiltExecutable(output, helperName);
		expect(selected).toBe(current);
		expect(fs.readFileSync(selected, "utf8")).toBe("current recording source");
	});

	it("fails if the authoritative current product is absent instead of selecting a stale legacy helper", () => {
		executable("arm64-apple-macosx/release", "stale helper");
		expect(() =>
			swiftBuiltExecutable(path.join(directory, "out/Products/Release"), helperName),
		).toThrow("current executable was not found");
	});

	it("supports older SwiftPM layouts when the installed tool itself reports that current output", () => {
		const current = executable("arm64-apple-macosx/release", "fresh older SwiftPM build");
		expect(swiftBuiltExecutable(path.dirname(current), helperName)).toBe(current);
	});

	it.each([
		"",
		"relative/release",
		"/first/path\n/second/path",
	])("rejects invalid authoritative output %j", (stdout) => {
		expect(() =>
			swiftBuildOutputDirectory({
				buildArgs: ["build"],
				cwd: directory,
				run: () => ({ status: 0, stdout, stderr: "" }),
			}),
		).toThrow("one absolute output directory");
	});

	it("fails output discovery when Swift returns an error", () => {
		expect(() =>
			swiftBuildOutputDirectory({
				buildArgs: ["build"],
				cwd: directory,
				run: () => ({ status: 1, stdout: "", stderr: "Invalid scratch configuration" }),
			}),
		).toThrow("Invalid scratch configuration");
	});

	it("does not stage a directory as the executable", () => {
		fs.mkdirSync(path.join(directory, helperName));
		expect(() => swiftBuiltExecutable(directory, helperName)).toThrow(
			"current executable was not found",
		);
	});

	it.runIf(process.platform !== "win32")("does not stage a non-executable file", () => {
		const helper = executable("out/Products/Release", "not executable");
		fs.chmodSync(helper, 0o644);
		expect(() => swiftBuiltExecutable(path.dirname(helper), helperName)).toThrow(
			"current executable was not found",
		);
	});
});

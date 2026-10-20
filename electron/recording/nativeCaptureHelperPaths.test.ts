import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildNativeMacCaptureHelperCandidates,
	buildNativeWindowsCaptureHelperCandidates,
} from "./nativeCaptureHelperPaths";

const repo = path.resolve("/capture-helper-test/checkout");
const helperName = "klippt-screencapturekit-helper";

describe("native macOS capture helper paths", () => {
	it("finds the real native build when Electron is launched through dist-electron/bootstrap.js", () => {
		const candidates = buildNativeMacCaptureHelperCandidates({
			appPath: path.join(repo, "dist-electron"),
			isPackaged: false,
			resourcesPath: "/resources",
			arch: "arm64",
			nativeDirectoryExists: (directory) => directory === path.join(repo, "electron", "native"),
		});
		expect(candidates).toContain(
			path.join(repo, "electron", "native", "screencapturekit", "build", helperName),
		);
		expect(candidates).toContain(
			path.join(repo, "electron", "native", "bin", "darwin-arm64", helperName),
		);
	});

	it("keeps explicit environment overrides first", () => {
		const candidates = buildNativeMacCaptureHelperCandidates({
			appPath: repo,
			isPackaged: false,
			resourcesPath: "/resources",
			arch: "x64",
			envOverride: " /custom/helper ",
			nativeDirectoryExists: () => false,
		});
		expect(candidates[0]).toBe("/custom/helper");
		expect(candidates).toContain(
			path.join(repo, "electron", "native", "bin", "darwin-x64", helperName),
		);
	});

	it("preserves packaged resource and unpacked paths without searching outside the bundle", () => {
		const directoryExists = vi.fn(() => true);
		const candidates = buildNativeMacCaptureHelperCandidates({
			appPath: path.join(repo, "app.asar"),
			isPackaged: true,
			resourcesPath: path.join(repo, "resources"),
			arch: "arm64",
			nativeDirectoryExists: directoryExists,
		});
		expect(directoryExists).not.toHaveBeenCalled();
		expect(candidates).toContain(
			path.join(
				repo,
				"app.asar.unpacked",
				"electron",
				"native",
				"screencapturekit",
				"build",
				helperName,
			),
		);
		expect(candidates).toContain(
			path.join(repo, "resources", "electron", "native", "bin", "darwin-arm64", helperName),
		);
	});

	it("bounds development ancestor discovery when the native directory is absent", () => {
		const directoryExists = vi.fn(() => false);
		const candidates = buildNativeMacCaptureHelperCandidates({
			appPath: path.join(repo, "one", "two", "three", "four", "five"),
			isPackaged: false,
			resourcesPath: "/resources",
			arch: "arm64",
			nativeDirectoryExists: directoryExists,
		});
		expect(directoryExists).toHaveBeenCalledTimes(4);
		expect(candidates).toHaveLength(2);
	});
});

describe("native Windows capture helper paths", () => {
	const windowsRepo = "C:\\capture-helper-test\\checkout";
	const winPath = path.win32;

	it("finds the checkout build from a Windows dist-electron entry path", () => {
		const candidates = buildNativeWindowsCaptureHelperCandidates({
			appPath: winPath.join(windowsRepo, "dist-electron"),
			isPackaged: false,
			resourcesPath: "C:\\resources",
			arch: "x64",
			pathAPI: winPath,
			nativeDirectoryExists: (directory) =>
				directory === winPath.join(windowsRepo, "electron", "native"),
		});
		expect(candidates).toContain(
			winPath.join(
				windowsRepo,
				"electron",
				"native",
				"wgc-capture",
				"build",
				"Release",
				"wgc-capture.exe",
			),
		);
		expect(candidates).toContain(
			winPath.join(windowsRepo, "electron", "native", "wgc-capture", "build", "wgc-capture.exe"),
		);
		expect(candidates).toContain(
			winPath.join(windowsRepo, "electron", "native", "bin", "win32-x64", "wgc-capture.exe"),
		);
	});

	it("preserves Windows override, release-build, unpacked and packaged-resource ordering", () => {
		const directoryExists = vi.fn(() => true);
		const candidates = buildNativeWindowsCaptureHelperCandidates({
			appPath: winPath.join(windowsRepo, "app.asar"),
			isPackaged: true,
			resourcesPath: "C:\\resources",
			arch: "arm64",
			pathAPI: winPath,
			envOverride: " C:\\custom\\wgc-capture.exe ",
			nativeDirectoryExists: directoryExists,
		});
		expect(directoryExists).not.toHaveBeenCalled();
		expect(candidates).toEqual([
			"C:\\custom\\wgc-capture.exe",
			winPath.join(
				windowsRepo,
				"app.asar.unpacked",
				"electron",
				"native",
				"wgc-capture",
				"build",
				"Release",
				"wgc-capture.exe",
			),
			winPath.join(
				windowsRepo,
				"app.asar.unpacked",
				"electron",
				"native",
				"wgc-capture",
				"build",
				"wgc-capture.exe",
			),
			winPath.join(
				windowsRepo,
				"app.asar.unpacked",
				"electron",
				"native",
				"bin",
				"win32-arm64",
				"wgc-capture.exe",
			),
			winPath.join("C:\\resources", "electron", "native", "bin", "win32-arm64", "wgc-capture.exe"),
		]);
	});
});

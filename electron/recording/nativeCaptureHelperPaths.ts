import { existsSync } from "node:fs";
import path from "node:path";

type CaptureHelperPathOptions = {
	appPath: string;
	isPackaged: boolean;
	resourcesPath: string;
	arch: string;
	envOverride?: string;
	nativeDirectoryExists?: (directory: string) => boolean;
	pathAPI?: Pick<typeof path, "dirname" | "join">;
};

function buildHelperCandidates(options: CaptureHelperPathOptions, locations: string[][]): string[] {
	const pathAPI = options.pathAPI ?? path;
	const bases = [options.appPath];
	if (!options.isPackaged) {
		const directoryExists = options.nativeDirectoryExists ?? existsSync;
		let directory = options.appPath;
		// Electron launched with dist-electron/bootstrap.js reports that directory
		// as appPath. The native build is under the enclosing checkout instead.
		for (let depth = 0; depth < 4; depth += 1) {
			const parent = pathAPI.dirname(directory);
			if (parent === directory) break;
			directory = parent;
			if (directoryExists(pathAPI.join(directory, "electron", "native"))) {
				bases.push(directory);
				break;
			}
		}
	}
	const candidates = bases.flatMap((base) =>
		locations.map((location) => pathAPI.join(base, ...location)),
	);
	if (options.isPackaged) {
		for (let index = 0; index < candidates.length; index += 1) {
			candidates[index] = candidates[index].replace(/\.asar([/\\])/, ".asar.unpacked$1");
		}
		candidates.push(pathAPI.join(options.resourcesPath, ...locations[locations.length - 1]));
	}
	const override = options.envOverride?.trim();
	return override ? [override, ...candidates] : candidates;
}

export function buildNativeMacCaptureHelperCandidates(options: CaptureHelperPathOptions): string[] {
	const helperName = "klippt-screencapturekit-helper";
	const archTag = options.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	return buildHelperCandidates(options, [
		["electron", "native", "screencapturekit", "build", helperName],
		["electron", "native", "bin", archTag, helperName],
	]);
}

export function buildNativeWindowsCaptureHelperCandidates(
	options: CaptureHelperPathOptions,
): string[] {
	const helperName = "wgc-capture.exe";
	const archTag = options.arch === "arm64" ? "win32-arm64" : "win32-x64";
	return buildHelperCandidates(options, [
		["electron", "native", "wgc-capture", "build", "Release", helperName],
		["electron", "native", "wgc-capture", "build", helperName],
		["electron", "native", "bin", archTag, helperName],
	]);
}

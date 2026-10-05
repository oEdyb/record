import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * Runtime ffmpeg resolution and isolated-track mapping, shared by export,
 * source-audio inspection and Clean Voice. The waveform-peaks decoder that used
 * to live here was archived with the editor at archive/pre-cleanup-2026-10-05.
 */

export type AudioTrackSelection = "mixed" | "microphone" | "system";

/**
 * Native Mac clips tag the isolated microphone track with the private ISO-639
 * language code `qac`. FFmpeg exposes that tag reliably, unlike AVAssetWriter's
 * common-title metadata. The required map rejects an older or non-Mac recording
 * with no isolated mic track; the IPC layer catches that result and automatic
 * camera direction stays off.
 */
export function audioTrackMapArgs(track: AudioTrackSelection): string[] {
	// Keep this map required. An optional metadata map falls back to FFmpeg's
	// automatic default-stream selection when qac is absent, which can mistake
	// mixed or system audio for microphone activity.
	if (track === "microphone") return ["-map", "0:m:language:qac"];
	if (track === "system") return ["-map", "0:m:language:qab"];
	return [];
}

/**
 * Where to find an ffmpeg that actually exists at runtime, in priority order.
 *
 * Note the Windows shape: `electron-builder.json5` deliberately excludes the
 * STATIC `ffmpeg.exe` (109 MB) from the installer, so resolving to it would
 * work in dev and fail in production — the exact class of bug that is invisible
 * until someone runs the packaged app. The SHARED build is 1 MB and links the
 * same `av*.dll` set the compositor already ships, so that is the one that gets
 * packaged (see the `filter` in electron-builder.json5) and the one preferred
 * here.
 */
export function ffmpegCandidates(here: string = process.cwd()): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	const env = process.env.OPENSCREEN_FFMPEG_PATH?.trim();
	const roots: string[] = [];
	// `app` is absent when this module is imported by a test.
	const appPath = (() => {
		try {
			return typeof app?.getAppPath === "function" ? app.getAppPath() : null;
		} catch {
			return null;
		}
	})();
	if (appPath) roots.push(appPath);
	if (process.resourcesPath) roots.push(process.resourcesPath);
	roots.push(here);

	const names =
		process.platform === "win32"
			? [
					// Staged flat by fetch-ffmpeg.mjs, beside the av*.dll set it links
					// against — the only ffmpeg the Windows installer carries.
					"ffmpeg-shared.exe",
					// The unpacked vendor tree, present in a dev checkout that has not
					// re-run the fetch script.
					path.join("ffmpeg-n8.1.2-win64-lgpl-shared", "bin", exe),
				]
			: [exe];
	return [
		...(env ? [env] : []),
		...roots.flatMap((root) =>
			names.map((n) => path.join(root, "electron", "native", "bin", tag, n)),
		),
		...(process.platform === "darwin"
			? [
					path.join(
						here,
						"crates",
						"thirdparty",
						"ffmpeg-n8.1.2-macos64-lgpl-shared",
						"bin",
						"ffmpeg",
					),
				]
			: []),
	];
}

let cachedFfmpeg: string | null | undefined;

/**
 * Whether a candidate is something that can actually be run.
 *
 * EXISTENCE IS NOT ENOUGH, and the difference is not academic. `existsSync` was
 * the test here, and it answers true for a DIRECTORY: on a Linux dev machine
 * `electron/native/bin/<tag>/ffmpeg` used to be a folder holding the capture
 * helper's shared libraries (`libavcodec.so.62` and friends) rather than the
 * binary, so resolution picked the folder, every later candidate was skipped,
 * and the failure surfaced much later as `spawn … EACCES` — a message that
 * blames permissions rather than saying the wrong candidate was chosen.
 *
 * Those libraries have since moved to `<tag>/helper-ffmpeg/`, so this path is
 * the executable's alone again. The check stays regardless: it costs one stat,
 * and it is the difference between a clear null and an EACCES half a subsystem
 * away.
 *
 * Every failure mode is swallowed on purpose. A candidate that is absent, not a
 * regular file, or not executable is simply not this one; throwing out of
 * resolution would let a single bad path deny a later, working one.
 *
 * `X_OK` and not `X_OK | R_OK`: executing a binary needs the execute bit, not
 * the read bit, so an install shipped `--x` is legitimate and must not be
 * refused. On Windows `X_OK` is not enforced at all — there the `isFile` check
 * is the whole guard, which is enough for the failure this exists to stop,
 * since `ffmpegCandidates` only ever proposes `.exe` names of its own.
 */
function isExecutableFile(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) {
			return false;
		}
		accessSync(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * First candidate that is an executable file, or null when none is (callers
 * fall back).
 */
export function resolveFfmpeg(here?: string): string | null {
	if (cachedFfmpeg !== undefined && here === undefined) return cachedFfmpeg;
	const found = ffmpegCandidates(here).find(isExecutableFile) ?? null;
	if (here === undefined) cachedFfmpeg = found;
	return found;
}

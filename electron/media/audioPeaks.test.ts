// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audioTrackMapArgs, ffmpegCandidates, resolveFfmpeg } from "./audioPeaks";

const ROOT = path.resolve(__dirname, "..", "..");

describe("audio track selection", () => {
	it("keeps the normal mixed waveform on ffmpeg's default audio track", () => {
		expect(audioTrackMapArgs("mixed")).toEqual([]);
	});

	it("selects only the isolated native Mac microphone track", () => {
		expect(audioTrackMapArgs("microphone")).toEqual(["-map", "0:m:language:qac"]);
	});

	it("selects only the isolated native Mac system-audio track", () => {
		expect(audioTrackMapArgs("system")).toEqual(["-map", "0:m:language:qab"]);
	});

	it.runIf(resolveFfmpeg(ROOT) !== null)(
		"fails closed instead of decoding the default track when qac is absent",
		() => {
			const ffmpeg = resolveFfmpeg(ROOT);
			if (!ffmpeg) throw new Error("FFmpeg disappeared after test selection");
			const folder = mkdtempSync(path.join(tmpdir(), "openscreen-audio-map-"));
			const fixture = path.join(folder, "mixed-only.m4a");
			try {
				const created = spawnSync(ffmpeg, [
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=1000:duration=0.2",
					"-c:a",
					"aac",
					"-metadata:s:a:0",
					"language=qaa",
					"-y",
					fixture,
				]);
				expect(created.status).toBe(0);

				const decoded = spawnSync(ffmpeg, [
					"-hide_banner",
					"-loglevel",
					"error",
					"-i",
					fixture,
					...audioTrackMapArgs("microphone"),
					"-f",
					"s16le",
					"-",
				]);
				expect(decoded.status).not.toBe(0);
				expect(decoded.stdout).toHaveLength(0);
			} finally {
				rmSync(folder, { recursive: true, force: true });
			}
		},
	);
});

describe("ffmpeg resolution", () => {
	it("prefers the shared build the installer actually ships", () => {
		const candidates = ffmpegCandidates(ROOT);
		const shared = candidates.findIndex((c) => c.endsWith("ffmpeg-shared.exe"));
		const vendorTree = candidates.findIndex((c) => c.includes("lgpl-shared"));
		if (process.platform === "win32") {
			expect(shared).toBeGreaterThanOrEqual(0);
			// The static ffmpeg.exe is excluded from the Windows installer
			// ("!win32-*/ffmpeg.exe"), so resolving to it would work in dev and fail
			// in production. It must not be a candidate at all.
			expect(
				candidates.some((c) => c.endsWith(`bin${path.sep}win32-x64${path.sep}ffmpeg.exe`)),
			).toBe(false);
			expect(shared).toBeLessThan(vendorTree);
		}
	});

	it("honours the env override first", () => {
		process.env.OPENSCREEN_FFMPEG_PATH = "/custom/ffmpeg";
		try {
			expect(ffmpegCandidates(ROOT)[0]).toBe("/custom/ffmpeg");
		} finally {
			process.env.OPENSCREEN_FFMPEG_PATH = undefined;
		}
	});

	it("returns null rather than throwing when nothing is staged", () => {
		expect(resolveFfmpeg(path.join(ROOT, "does", "not", "exist"))).toBeNull();
	});

	/**
	 * The shape that slipped through. A Linux dev checkout used to have
	 * `electron/native/bin/<tag>/ffmpeg` as a DIRECTORY of shared libraries
	 * rather than the binary; `existsSync` accepted it, resolution stopped
	 * there, and the failure only surfaced later as `spawn … EACCES`.
	 *
	 * That particular collision is gone — the helper's libraries moved to
	 * `helper-ffmpeg/` — but the assertion stays, because it is really about
	 * `resolveFfmpeg` not confusing existence with executability, and the next
	 * thing to land a directory on a candidate path will not announce itself
	 * either.
	 */
	it("skips a candidate that is a directory rather than the binary", () => {
		const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
		const tag = `${process.platform}-${process.arch}`;
		const name = process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg";
		const staged = path.join(here, "electron", "native", "bin", tag, name);
		try {
			// A directory sitting exactly where the executable is looked for.
			mkdirSync(staged, { recursive: true });
			writeFileSync(path.join(staged, "libavcodec.so.62"), "");

			expect(resolveFfmpeg(here)).toBeNull();
		} finally {
			rmSync(here, { recursive: true, force: true });
		}
	});

	it("accepts a candidate that is an executable file", () => {
		const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
		const tag = `${process.platform}-${process.arch}`;
		const name = process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg";
		const staged = path.join(here, "electron", "native", "bin", tag, name);
		try {
			mkdirSync(path.dirname(staged), { recursive: true });
			writeFileSync(staged, "", { mode: 0o755 });

			expect(resolveFfmpeg(here)).toBe(staged);
		} finally {
			rmSync(here, { recursive: true, force: true });
		}
	});

	// Non-executable files are the other half of the predicate, and the check is
	// only meaningful where the OS enforces the bit.
	it.runIf(process.platform !== "win32")(
		"skips a candidate that is a file but not executable",
		() => {
			const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
			const staged = path.join(
				here,
				"electron",
				"native",
				"bin",
				`${process.platform}-${process.arch}`,
				"ffmpeg",
			);
			try {
				mkdirSync(path.dirname(staged), { recursive: true });
				writeFileSync(staged, "", { mode: 0o644 });

				expect(resolveFfmpeg(here)).toBeNull();
			} finally {
				rmSync(here, { recursive: true, force: true });
			}
		},
	);

	/**
	 * REJECTING IS NOT THE SAME AS CONTINUING, and only the second is the
	 * property the predicate exists for: swallowing every failure is what stops
	 * one bad path from denying a later working one. The tests above prove the
	 * first — with a single candidate staged, `null` is equally consistent with
	 * "skipped it" and "gave up on the whole list".
	 *
	 * `OPENSCREEN_FFMPEG_PATH` is the vehicle because `ffmpegCandidates` puts it
	 * FIRST, so a bad value there is the one case that could shadow every real
	 * candidate behind it.
	 */
	describe("falling through to a later candidate", () => {
		let here: string;
		let staged: string;

		beforeEach(() => {
			here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
			staged = path.join(
				here,
				"electron",
				"native",
				"bin",
				`${process.platform}-${process.arch}`,
				process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg",
			);
			mkdirSync(path.dirname(staged), { recursive: true });
			writeFileSync(staged, "", { mode: 0o755 });
		});

		afterEach(() => {
			delete process.env.OPENSCREEN_FFMPEG_PATH;
			rmSync(here, { recursive: true, force: true });
		});

		it("passes over a leading candidate that does not exist", () => {
			process.env.OPENSCREEN_FFMPEG_PATH = path.join(here, "nowhere", "ffmpeg");

			expect(resolveFfmpeg(here)).toBe(staged);
		});

		it("passes over a leading candidate that is a directory", () => {
			const decoy = path.join(here, "decoy-ffmpeg");
			mkdirSync(decoy, { recursive: true });
			writeFileSync(path.join(decoy, "libavcodec.so.62"), "");
			process.env.OPENSCREEN_FFMPEG_PATH = decoy;

			expect(resolveFfmpeg(here)).toBe(staged);
		});

		it.runIf(process.platform !== "win32")(
			"passes over a leading candidate that is not executable",
			() => {
				const decoy = path.join(here, "decoy-ffmpeg");
				writeFileSync(decoy, "", { mode: 0o644 });
				process.env.OPENSCREEN_FFMPEG_PATH = decoy;

				expect(resolveFfmpeg(here)).toBe(staged);
			},
		);

		// An unreadable-but-executable binary is legitimate on Unix, so it must be
		// ACCEPTED rather than fallen through — `X_OK` is deliberately not paired
		// with `R_OK`. Skipped as root, for whom access checks always pass.
		it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
			"still accepts an execute-only binary",
			() => {
				const executableOnly = path.join(here, "exec-only-ffmpeg");
				writeFileSync(executableOnly, "", { mode: 0o111 });
				process.env.OPENSCREEN_FFMPEG_PATH = executableOnly;

				expect(resolveFfmpeg(here)).toBe(executableOnly);
			},
		);
	});
});

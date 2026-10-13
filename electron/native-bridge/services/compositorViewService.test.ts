import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_THEMES, DEFAULT_CURSOR_SPRITES } from "../../../src/lib/cursor/cursorThemes";
import { AtomicExportPublisher } from "../../export/atomicExport";
import type { RecordingFastExportPlan } from "../../export/recordingFastExport";
import type {
	CompositorViewAddon,
	ExportStats,
	GifExportStats,
} from "../../native/compositor-view/addon";
import {
	buildCandidatePaths,
	CompositorViewService,
	calculateSceneExportDuration,
	ffmpegSharedBinCandidates,
	resolveClipSourceDurations,
	resolveSceneAssetPath,
	resolveSceneAssetPaths,
} from "./compositorViewService";

/** A source checkout's `crates/.cargo/config.toml`, with `FFMPEG_DIR` written as `body`. */
function writeCargoConfig(root: string, body: string): void {
	const cargoDir = path.join(root, "crates", ".cargo");
	fs.mkdirSync(cargoDir, { recursive: true });
	fs.writeFileSync(
		path.join(cargoDir, "config.toml"),
		`# pin comment\n[env]\n${body}\nLIBCLANG_PATH = "C:\\\\Program Files\\\\LLVM\\\\bin"\n`,
		"utf8",
	);
}

describe("ffmpegSharedBinCandidates", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-ffmpeg-pin-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("reads the dev-vendored dir off the cargo pin instead of a second hardcoded copy of the name", () => {
		// The pin has moved before (floating `master-latest` → fixed `n8.1.2`) and
		// left this list probing a directory that no longer existed. Deriving it
		// means the next repin cannot rot the loader.
		writeCargoConfig(
			tmpRoot,
			`FFMPEG_DIR = { value = "thirdparty/ffmpeg-n9.9.9-win64-lgpl-shared", relative = true }`,
		);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(
			`${tmpRoot.replace(/\\/g, "/")}/crates/thirdparty/ffmpeg-n9.9.9-win64-lgpl-shared/bin`,
		);
		expect(candidates[1]).toMatch(/electron\/native\/bin\/(win32|darwin|linux)-(x64|arm64)$/);
	});

	it("accepts the plain-string spelling of the pin as well as the table one", () => {
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "thirdparty/ffmpeg-plain"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(`${tmpRoot.replace(/\\/g, "/")}/crates/thirdparty/ffmpeg-plain/bin`);
	});

	it("keeps an absolute pin absolute rather than nesting it under the crate dir", () => {
		// `path.isAbsolute` is platform-dependent — "C:/vendor" is absolute on
		// Windows and relative on POSIX — so spell the pin through path.resolve
		// and assert the behaviour rather than one platform's drive letter.
		const absolutePin = path.resolve("/vendor/ffmpeg").replace(/\\/g, "/");
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "${absolutePin}"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(`${absolutePin}/bin`);
		expect(candidates[0]).not.toContain("crates");
	});

	it("starts at the arch-tagged native bin dir when there is no cargo pin to read", () => {
		// Packaged builds ship no `crates/` at all — the dev candidate must drop
		// out silently rather than contribute a path that can never exist.
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toMatch(/electron\/native\/bin\/(win32|darwin|linux)-(x64|arm64)$/);
		expect(candidates.some((c) => c.includes("crates"))).toBe(false);
	});

	it("ignores a cargo config that pins no FFMPEG_DIR", () => {
		writeCargoConfig(tmpRoot, `SOME_OTHER_VAR = "thirdparty/nope"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates.some((c) => c.includes("crates"))).toBe(false);
	});

	it("also probes process.resourcesPath, since electron/native/bin ships only via extraResources in packaged builds", () => {
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = { value = "thirdparty/ffmpeg-x", relative = true }`);
		const original = process.resourcesPath;
		Object.defineProperty(process, "resourcesPath", {
			value: "C:/fake/resources",
			configurable: true,
		});
		try {
			const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));
			expect(candidates).toContain(
				`C:/fake/resources/electron/native/bin/${candidates[1]!.split("/").at(-1)}`,
			);
		} finally {
			Object.defineProperty(process, "resourcesPath", { value: original, configurable: true });
		}
	});
});

describe("CompositorViewService export transaction", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-compositor-export-"));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const stats: ExportStats = {
		frames: 60,
		wallS: 1,
		fps: 60,
		videoDurationS: 2,
		audioMastering: {
			enabled: true,
			analyzed: true,
			appliedGainDb: 0,
			limitedByTruePeak: false,
			limitedByGainCap: false,
		},
		encoderName: "test",
		encoderHardware: false,
		encoderFallback: false,
		decoderPath: "test",
		compositorBackend: "test",
	};

	const clips = [
		{
			screenPath: "/recording/screen.mp4",
			webcamPath: "/recording/camera.mp4",
			sourceStartSec: 0,
			sourceEndSec: 2,
			webcamOffsetSec: 0,
			hasAudio: true,
		},
	];

	it("uses speed-adjusted output duration for fallback capacity estimates", () => {
		expect(
			calculateSceneExportDuration(
				clips,
				JSON.stringify({
					speedRegions: [{ clipIndex: 0, startSec: 0, endSec: 2, speed: 0.25 }],
				}),
			),
		).toBe(8);
	});

	it("fills missing ends, clamps provisional ends, and probes each source once", async () => {
		const probeMediaDuration = vi.fn(async () => 2);
		const resolved = await resolveClipSourceDurations(
			[
				{ ...clips[0]!, sourceEndSec: 0 },
				{ ...clips[0]!, sourceStartSec: 0.5, sourceEndSec: 60 },
			],
			probeMediaDuration,
		);

		expect(probeMediaDuration).toHaveBeenCalledOnce();
		expect(resolved.map((clip) => clip.sourceEndSec)).toEqual([2, 2]);
	});

	it("keeps an explicit trim shorter than the probed source", async () => {
		const resolved = await resolveClipSourceDurations(
			[{ ...clips[0]!, sourceStartSec: 0.25, sourceEndSec: 1.25 }],
			async () => 2,
		);

		expect(resolved[0]?.sourceEndSec).toBe(1.25);
	});

	it("refuses to save over one of the export's own recordings", async () => {
		const screenPath = path.join(root, "screen.mp4");
		fs.writeFileSync(screenPath, "original");
		fs.symlinkSync(screenPath, path.join(root, "alias.mp4"));
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti: vi.fn(),
			verifyVideoExport: vi.fn(),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});

		for (const target of [screenPath, path.join(root, "alias.mp4")])
			await expect(service.exportMulti([{ ...clips[0]!, screenPath }], target)).rejects.toThrow(
				"Choose another file name. This file is one of the recordings in this export.",
			);
		expect(addon.exportMulti).not.toHaveBeenCalled();
		expect(fs.readFileSync(screenPath, "utf8")).toBe("original");
	});

	it("fails before rendering when a source duration cannot be probed", async () => {
		const addon = {
			probeMediaDuration: vi.fn(async () => {
				throw new Error("unsupported container");
			}),
			exportMulti: vi.fn(),
			verifyVideoExport: vi.fn(),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});

		await expect(
			service.exportMulti([{ ...clips[0]!, sourceEndSec: 0 }], path.join(root, "unreadable.mp4")),
		).rejects.toThrow(/Unable to read media duration.*unsupported container/);
		expect(addon.exportMulti).not.toHaveBeenCalled();
	});

	it.each([
		"mp4",
		"gif",
	] as const)("releases cancellation state and parent abort listener after a failed %s duration probe", async (format) => {
		const signal = new AbortController().signal;
		const removeListener = vi.spyOn(signal, "removeEventListener");
		const cancelExport = vi.fn(() => true);
		const addon = {
			probeMediaDuration: vi.fn(async () => {
				throw new Error("unreadable source");
			}),
			verifyVideoExport: vi.fn(),
			verifyGifExport: vi.fn(),
			cancelExport,
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "cleanup.json"),
		});
		const method =
			format === "mp4" ? service.exportMulti.bind(service) : service.exportGif.bind(service);
		await expect(
			method(clips, path.join(root, `failed.${format}`), undefined, undefined, undefined, {
				exportId: "failed-probe",
				signal,
			}),
		).rejects.toThrow("unreadable source");
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
		service.cancelExport("failed-probe");
		expect(cancelExport).not.toHaveBeenCalled();
	});

	it("verifies remux cadence after a closing frame changes the source guess from 600 to 58, with truthful frame stats", async () => {
		const finalPath = path.join(root, "preserved.mp4");
		fs.writeFileSync(finalPath, "old export");
		const rawStats = {
			...stats,
			frames: 40,
			encoderName: "stream-copy/h264",
			decoderPath: "packet-copy",
		};
		const render = vi.fn(async (outPath: string) => {
			await fs.promises.writeFile(outPath, "preserved video");
			plan.fps = 58;
			return rawStats;
		});
		const plan: RecordingFastExportPlan = {
			expectedBytes: 50_000_000,
			fps: 600,
			durationS: 2,
			render,
		};
		const verifyVideoExport = vi.fn(async () => {
			expect(fs.readFileSync(finalPath, "utf8")).toBe("old export");
		});
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti: vi.fn(),
			verifyVideoExport,
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const publisher = new AtomicExportPublisher({
			journalPath: path.join(root, "fast-journal.json"),
			getAvailableBytes: async () => 1024n ** 4n,
		});
		const publish = vi.spyOn(publisher, "publish");
		const prepare = vi.fn(async () => plan);
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportPublisher: publisher,
			recordingFastExport: prepare,
		});
		const result = await service.exportMulti(clips, finalPath, "identity scene", {
			width: 320,
			height: 240,
			fps: 60,
			codec: "h264",
			preserveRecordingSource: true,
		});
		expect(result).toEqual(rawStats);
		expect(addon.exportMulti).not.toHaveBeenCalled();
		expect(addon.probeMediaDuration).toHaveBeenCalledOnce();
		expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ sourceDurationSec: 2 }));
		expect(verifyVideoExport).toHaveBeenCalledTimes(2);
		expect(verifyVideoExport).toHaveBeenLastCalledWith(
			expect.any(String),
			{ width: 320, height: 240, fps: 58, durationS: 2, codec: "h264" },
			expect.any(String),
		);
		expect(publish).toHaveBeenCalledWith(expect.objectContaining({ expectedBytes: 50_000_000 }));
		expect(fs.readFileSync(finalPath, "utf8")).toBe("preserved video");
	});

	it.each([
		"render",
		"verification",
	] as const)("falls back atomically when source-copy %s fails", async (phase) => {
		const finalPath = path.join(root, "fallback.mp4");
		fs.writeFileSync(finalPath, "old export");
		const plan: RecordingFastExportPlan = {
			expectedBytes: 1000,
			fps: 60,
			durationS: 2,
			render: async (outPath) => {
				await fs.promises.writeFile(outPath, "unverified copy");
				if (phase === "render") throw new Error("copy failed");
				return stats;
			},
		};
		const verifyVideoExport = vi.fn(async () => {
			expect(fs.readFileSync(finalPath, "utf8")).toBe("old export");
		});
		if (phase === "verification")
			verifyVideoExport.mockRejectedValueOnce(new Error("source tail unavailable"));
		const exportMulti = vi.fn(async (_clips: unknown, outPath: string) => {
			expect(fs.existsSync(outPath)).toBe(false);
			await fs.promises.writeFile(outPath, "verified render");
			return stats;
		});
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti,
			verifyVideoExport,
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "fallback.json"),
			recordingFastExport: async () => plan,
		});
		await service.exportMulti(clips, finalPath, undefined, {
			width: 320,
			height: 240,
			fps: 60,
			preserveRecordingSource: true,
		});
		expect(exportMulti).toHaveBeenCalledOnce();
		expect(verifyVideoExport).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ fps: 30 }),
			expect.any(String),
		);
		expect(fs.readFileSync(finalPath, "utf8")).toBe("verified render");
	});

	it("cancels a source-copy without starting a fallback render or changing the destination", async () => {
		const finalPath = path.join(root, "cancel-copy.mp4");
		fs.writeFileSync(finalPath, "old export");
		let stagedPath = "";
		let listening = false;
		const render = vi.fn(async (outPath: string, signal: AbortSignal) => {
			stagedPath = outPath;
			await fs.promises.writeFile(outPath, "partial copy");
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("copy cancelled")), { once: true });
				listening = true;
			});
			return stats;
		});
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti: vi.fn(),
			verifyVideoExport: vi.fn(),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "cancel-copy.json"),
			recordingFastExport: async () => ({ expectedBytes: 1000, fps: 60, durationS: 2, render }),
		});
		const operation = service.exportMulti(
			clips,
			finalPath,
			undefined,
			{ preserveRecordingSource: true },
			undefined,
			{ exportId: "copy-cancel" },
		);
		await vi.waitFor(() => expect(listening).toBe(true));
		service.cancelExport("copy-cancel");
		await expect(operation).rejects.toThrow(/cancel/i);
		expect(addon.exportMulti).not.toHaveBeenCalled();
		expect(addon.verifyVideoExport).not.toHaveBeenCalled();
		expect(fs.readFileSync(finalPath, "utf8")).toBe("old export");
		expect(fs.existsSync(stagedPath)).toBe(false);
	});

	it("renders MP4 with the resolved clip extent and a positive capacity estimate", async () => {
		const finalPath = path.join(root, "resolved.mp4");
		const exportMulti = vi.fn(async (_clips: unknown, outPath: string) => {
			await fs.promises.writeFile(outPath, "verified export");
			return stats;
		});
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti,
			verifyVideoExport: vi.fn(async () => ({
				durationS: 2,
				fps: 30,
				videoStreams: 1,
				audioStreams: 1,
				firstVideoFrameS: 0,
				tailVideoFrameS: 1,
			})),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});

		await service.exportMulti([{ ...clips[0]!, sourceEndSec: 0 }], finalPath, undefined, {
			width: 320,
			height: 240,
			fps: 30,
			codec: "h264",
		});

		expect(exportMulti.mock.calls[0]?.[0]).toMatchObject([{ sourceEndSec: 2 }]);
		expect(fs.readFileSync(finalPath, "utf8")).toBe("verified export");
	});

	it("renders and verifies a sibling before it publishes the requested MP4", async () => {
		const finalPath = path.join(root, "video.mp4");
		let nativePath = "";
		const verifyVideoExport = vi.fn(async () => ({
			durationS: 2,
			fps: 30,
			videoStreams: 1,
			audioStreams: 1,
			firstVideoFrameS: 0,
			tailVideoFrameS: 1,
		}));
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti: vi.fn(async (_clips, outPath: string) => {
				nativePath = outPath;
				await fs.promises.writeFile(outPath, "verified export");
				return stats;
			}),
			verifyVideoExport,
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});

		await service.exportMulti(clips, finalPath, undefined, {
			width: 320,
			height: 240,
			fps: 30,
			codec: "h264",
		});

		expect(nativePath).not.toBe(finalPath);
		expect(path.dirname(nativePath)).toBe(root);
		expect(verifyVideoExport).toHaveBeenCalledWith(
			nativePath,
			{
				width: 320,
				height: 240,
				fps: 30,
				durationS: 2,
				codec: "h264",
			},
			expect.any(String),
		);
		expect(fs.readFileSync(finalPath, "utf8")).toBe("verified export");
		expect(fs.existsSync(nativePath)).toBe(false);
	});

	it("returns a structured warning when post-commit directory durability is unconfirmed", async () => {
		const finalPath = path.join(root, "warning.mp4");
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti: vi.fn(async (_clips, outPath: string) => {
				await fs.promises.writeFile(outPath, "verified export");
				return stats;
			}),
			verifyVideoExport: vi.fn(async () => ({
				durationS: 2,
				fps: 30,
				videoStreams: 1,
				audioStreams: 1,
				firstVideoFrameS: 0,
				tailVideoFrameS: 1,
			})),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const exportPublisher = new AtomicExportPublisher({
			journalPath: path.join(root, "warning-journal.json"),
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			syncDirectory: async () => {
				throw Object.assign(new Error("device did not sync"), { code: "EIO" });
			},
		});
		const service = new CompositorViewService({ addon, appRoot: root, exportPublisher });

		const result = await service.exportMulti(clips, finalPath, undefined, {
			width: 320,
			height: 240,
			fps: 30,
			codec: "h264",
		});

		expect(result?.exportWarning).toMatchObject({
			phase: "publishing",
			code: "DURABILITY_UNCONFIRMED",
			retryable: false,
		});
		expect(fs.readFileSync(finalPath, "utf8")).toBe("verified export");
	});

	it("verifies GIF dimensions, frame rate, duration, and decoded tail before publishing", async () => {
		const finalPath = path.join(root, "animation.gif");
		const gifStats: GifExportStats = {
			frames: 24,
			wallS: 0.5,
			fps: 48,
			videoDurationS: 2,
			fileBytes: 42,
		};
		const verifyGifExport = vi.fn(async () => ({
			durationS: 2,
			fps: 12,
			videoStreams: 1,
			firstFrameS: 0,
			tailFrameS: 1.92,
		}));
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportGif: vi.fn(async (_clips, outPath: string) => {
				await fs.promises.writeFile(outPath, "verified GIF");
				return gifStats;
			}),
			verifyGifExport,
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});

		await service.exportGif(clips, finalPath, undefined, {
			width: 320,
			height: 240,
			fps: 12,
		});

		expect(verifyGifExport).toHaveBeenCalledWith(
			expect.stringContaining(".klippt-export-"),
			{
				width: 320,
				height: 240,
				fps: 12,
				durationS: 2,
			},
			expect.any(String),
		);
		expect(fs.readFileSync(finalPath, "utf8")).toBe("verified GIF");
	});

	it("stops the native loop and preserves the old final file when cancelled", async () => {
		const finalPath = path.join(root, "video.mp4");
		fs.writeFileSync(finalPath, "old export");
		let rejectRender: ((error: Error) => void) | null = null;
		const exportMulti = vi.fn((_clips, outPath: string) => {
			return new Promise<ExportStats>((_resolve, reject) => {
				rejectRender = reject;
				fs.writeFileSync(outPath, "partial export");
			});
		});
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti,
			verifyVideoExport: vi.fn(),
			cancelExport: vi.fn(() => {
				rejectRender?.(new Error("export cancelled"));
				return true;
			}),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});
		const operation = service.exportMulti(clips, finalPath, undefined, undefined, undefined, {
			exportId: "cancel-me",
		});

		await vi.waitFor(() => expect(exportMulti).toHaveBeenCalledOnce());
		expect(rejectRender).not.toBeNull();
		expect(service.cancelExport("cancel-me")).toBe(true);
		await expect(operation).rejects.toMatchObject({ code: "CANCELLED", phase: "rendering" });
		expect(fs.readFileSync(finalPath, "utf8")).toBe("old export");
		expect(fs.readdirSync(root).some((entry) => entry.includes(".klippt-export-"))).toBe(false);
	});

	it("cancels native verification and preserves the old final file", async () => {
		const finalPath = path.join(root, "video.mp4");
		fs.writeFileSync(finalPath, "old export");
		let rejectVerification: ((error: Error) => void) | null = null;
		const verifyVideoExport = vi.fn(
			async (_path: string, _input: unknown, exportId?: string) =>
				await new Promise<never>((_resolve, reject) => {
					expect(exportId).toBe("cancel-verification");
					rejectVerification = reject;
				}),
		);
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti: vi.fn(async (_clips, outPath: string) => {
				await fs.promises.writeFile(outPath, "complete export");
				return stats;
			}),
			verifyVideoExport,
			cancelExport: vi.fn(() => {
				rejectVerification?.(new Error("verification cancelled"));
				return true;
			}),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});
		const operation = service.exportMulti(clips, finalPath, undefined, undefined, undefined, {
			exportId: "cancel-verification",
		});

		await vi.waitFor(() => expect(verifyVideoExport).toHaveBeenCalledOnce());
		expect(service.cancelExport("cancel-verification")).toBe(true);
		await expect(operation).rejects.toMatchObject({ code: "CANCELLED", phase: "verification" });
		expect(fs.readFileSync(finalPath, "utf8")).toBe("old export");
	});

	it("cancels voiceover-buffer verification before atomic publication", async () => {
		const finalPath = path.join(root, "voiceover.mp4");
		fs.writeFileSync(finalPath, "old export");
		let rejectVerification: ((error: Error) => void) | null = null;
		const addon = {
			verifyVideoExport: vi.fn(
				async (_path: string, _input: unknown, exportId?: string) =>
					await new Promise<never>((_resolve, reject) => {
						expect(exportId).toBe("buffer-cancel");
						rejectVerification = reject;
					}),
			),
			cancelExport: vi.fn(() => {
				rejectVerification?.(new Error("verification cancelled"));
				return true;
			}),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});
		const operation = service.publishVideoBuffer(
			new Uint8Array([1, 2, 3]).buffer,
			finalPath,
			{
				width: 320,
				height: 240,
				fps: 30,
				durationS: 2,
				codec: "h264",
				expectedBytes: 3,
			},
			{ exportId: "buffer-cancel" },
		);

		await vi.waitFor(() => expect(addon.verifyVideoExport).toHaveBeenCalledOnce());
		expect(service.cancelExport("buffer-cancel")).toBe(true);
		await expect(operation).rejects.toMatchObject({ code: "CANCELLED", phase: "verification" });
		expect(fs.readFileSync(finalPath, "utf8")).toBe("old export");
	});

	it("remembers a cancellation that arrives before the export is registered", async () => {
		const finalPath = path.join(root, "video.mp4");
		fs.writeFileSync(finalPath, "old export");
		const exportMulti = vi.fn(async () => stats);
		const addon = {
			probeMediaDuration: vi.fn(async () => 2),
			exportMulti,
			verifyVideoExport: vi.fn(),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const service = new CompositorViewService({
			addon,
			appRoot: root,
			exportJournalPath: path.join(root, "journal.json"),
		});

		expect(service.cancelExport("cancel-before-start")).toBe(true);
		await expect(
			service.exportMulti(clips, finalPath, undefined, undefined, undefined, {
				exportId: "cancel-before-start",
			}),
		).rejects.toMatchObject({ code: "CANCELLED", phase: "preflight" });

		expect(exportMulti).not.toHaveBeenCalled();
		expect(fs.readFileSync(finalPath, "utf8")).toBe("old export");
	});
});

describe("buildCandidatePaths", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-addon-path-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	const norm = (p: string) => p.replace(/\\/g, "/");

	it("finds the addon from dist-electron, which is what app.getAppPath() returns unpackaged", () => {
		// The regression this exists for: `electron dist-electron/bootstrap.js` — the entry
		// `npm run dev` uses — makes app.getAppPath() the dist-electron DIRECTORY, not
		// the checkout root. Every candidate was built by joining "electron/native/..."
		// onto it, so none of them existed and the editor ran with a no-op compositor
		// on a machine that had a perfectly good addon one level up.
		fs.mkdirSync(path.join(tmpRoot, "electron", "native", "bin"), { recursive: true });
		const appRoot = path.join(tmpRoot, "dist-electron");
		fs.mkdirSync(appRoot, { recursive: true });

		const candidates = buildCandidatePaths(appRoot, false, null).map(norm);

		expect(
			candidates.some((c) => c.startsWith(norm(tmpRoot)) && !c.includes("dist-electron")),
		).toBe(true);
	});

	it("stops walking up when no ancestor holds electron/native", () => {
		const appRoot = path.join(tmpRoot, "nothing", "here");
		fs.mkdirSync(appRoot, { recursive: true });

		const candidates = buildCandidatePaths(appRoot, false, null).map(norm);

		expect(candidates.every((c) => c.startsWith(norm(appRoot)) || c.includes("resources"))).toBe(
			true,
		);
	});

	it("also probes process.resourcesPath, where extraResources actually puts the addon", () => {
		// electron-builder ships electron/native/bin/<tag>/** through extraResources,
		// so in a packaged build the addon is at <resources>/electron/native/bin/<tag>
		// and NEVER inside app.asar — the .asar → .asar.unpacked rewrite cannot reach a
		// file that was never in the archive.
		const original = process.resourcesPath;
		Object.defineProperty(process, "resourcesPath", {
			value: "/fake/resources",
			configurable: true,
		});
		try {
			const candidates = buildCandidatePaths("/fake/resources/app.asar", true, null).map(norm);
			expect(
				candidates.some(
					(c) => c.startsWith("/fake/resources/electron/native/bin/") && c.endsWith(".node"),
				),
			).toBe(true);
		} finally {
			Object.defineProperty(process, "resourcesPath", { value: original, configurable: true });
		}
	});

	it("keeps the env override first", () => {
		const candidates = buildCandidatePaths(tmpRoot, false, "/explicit/compositor_view.node");
		expect(norm(candidates[0]!)).toBe("/explicit/compositor_view.node");
	});
});

describe("CompositorViewService ffmpeg PATH prepend", () => {
	let tmpRoot: string;
	let originalPath: string | undefined;
	let originalPlatform: PropertyDescriptor | undefined;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-compositor-test-"));
		originalPath = process.env.PATH;
		originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
		process.env.PATH = originalPath;
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	/** Lay down a source checkout: the cargo pin plus the tree it points at. */
	function vendorPinnedFfmpeg(root: string): string {
		writeCargoConfig(
			root,
			`FFMPEG_DIR = { value = "thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared", relative = true }`,
		);
		const dir = path.join(root, "crates", "thirdparty", "ffmpeg-n8.1.2-win64-lgpl-shared", "bin");
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	it("prepends the ffmpeg shared-DLL dir to PATH when it exists, even though the addon itself is absent", () => {
		const ffmpegDir = vendorPinnedFfmpeg(tmpRoot);
		process.env.PATH = "C:\\Windows\\System32";

		const service = new CompositorViewService({ appRoot: tmpRoot, isPackaged: false });
		expect(service.hasAddon()).toBe(false); // no compositor_view.node under tmpRoot
		expect(process.env.PATH?.split(path.delimiter)).toContain(ffmpegDir);
	});

	it("skips a pinned dir the checkout never vendored, instead of putting a dead path on PATH", () => {
		// The exact rot this derivation removes: a pin naming a tree that isn't
		// on disk must contribute nothing, not a candidate that can never resolve.
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "thirdparty/ffmpeg-not-vendored"`);
		process.env.PATH = "C:\\Windows\\System32";
		const before = process.env.PATH;

		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();

		expect(process.env.PATH).toBe(before);
	});

	it("leaves PATH untouched when no ffmpeg shared-DLL dir exists", () => {
		process.env.PATH = "C:\\Windows\\System32";
		const before = process.env.PATH;

		const service = new CompositorViewService({ appRoot: tmpRoot, isPackaged: false });
		service.hasAddon();

		expect(process.env.PATH).toBe(before);
	});

	it("does not duplicate the entry when PATH already contains it", () => {
		const ffmpegDir = vendorPinnedFfmpeg(tmpRoot);
		process.env.PATH = "C:\\Windows\\System32";

		// simulates a second view/service instance loading after PATH was
		// already primed by the first — same appRoot, fresh instance.
		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();
		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();

		const occurrences = process.env.PATH?.split(path.delimiter).filter((p) => p === ffmpegDir);
		expect(occurrences?.length).toBe(1);
	});
});

describe("resolveSceneAssetPaths", () => {
	// A packaged install: `wallpapers/` and `cursors/` exist as real files under
	// resourcesPath (extraResources), while VITE_PUBLIC points into the asar, where
	// nothing is readable by the Rust addon — the exact layout that broke both features.
	let resources: string;
	let originalResourcesPath: PropertyDescriptor | undefined;
	let originalVitePublic: string | undefined;
	const themed = CURSOR_THEMES.find((t) => t.assets.arrow);

	beforeEach(() => {
		resources = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-scene-assets-"));
		fs.mkdirSync(path.join(resources, "wallpapers"), { recursive: true });
		fs.writeFileSync(path.join(resources, "wallpapers", "wallpaper1.jpg"), "jpg");
		const assetPaths = [
			...Object.values(themed?.assets ?? {}).map((a) => a.assetPath),
			...Object.values(DEFAULT_CURSOR_SPRITES).map((s) => s.assetPath),
		];
		for (const assetPath of assetPaths) {
			const file = path.join(resources, assetPath);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "png");
		}
		originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
		Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
		originalVitePublic = process.env.VITE_PUBLIC;
		// vite copies public/ into dist, so the names exist inside the archive — but the
		// archive is a file, so no candidate under it can ever pass an existence check.
		process.env.VITE_PUBLIC = path.join(resources, "app.asar", "dist");
	});

	afterEach(() => {
		if (originalResourcesPath) {
			Object.defineProperty(process, "resourcesPath", originalResourcesPath);
		}
		if (originalVitePublic === undefined) {
			// `NodeJS.ProcessEnv.VITE_PUBLIC` is declared non-optional (electron-env.d.ts),
			// so `delete` is rejected outright even though main.ts only assigns it at
			// startup and it really is absent under vitest. Reflect deletes the same key.
			Reflect.deleteProperty(process.env, "VITE_PUBLIC");
		} else {
			process.env.VITE_PUBLIC = originalVitePublic;
		}
		fs.rmSync(resources, { recursive: true, force: true });
	});

	function resolved(scene: Record<string, unknown>) {
		return JSON.parse(resolveSceneAssetPaths(JSON.stringify(scene)));
	}

	/** What `resolveSceneAssetPaths` writes into `cursor.cursorSprites` — same shape the
	 *  service declares for the sprite map it builds. */
	type ResolvedSprite = { path: string; hotspotX: number; hotspotY: number };

	it("resolves a bundled wallpaper to the extraResources copy, not the unreadable asar path", () => {
		const out = resolved({ background: { kind: "image", path: "/wallpapers/wallpaper1.jpg" } });

		expect(out.background.path).toBe(path.join(resources, "wallpapers", "wallpaper1.jpg"));
		expect(out.background.path).not.toContain("app.asar");
		expect(fs.existsSync(out.background.path)).toBe(true);
	});

	it("resolves a cursor theme's arrow sprite to a path that exists on disk", () => {
		if (!themed) return; // no bundled theme ships an arrow override
		const arrow = resolved({ cursor: { theme: themed.id } }).cursor.cursorSprites.arrow;

		expect(arrow.path).toBe(path.join(resources, themed.assets.arrow!.assetPath));
		expect(fs.existsSync(arrow.path)).toBe(true);
	});

	it("fills the states a theme doesn't ship with the built-in art", () => {
		if (!themed) return;
		const sprites = resolved({ cursor: { theme: themed.id } }).cursor.cursorSprites;

		// The sweezy packs only carry an arrow and a pointer, but a recording walks through
		// far more states than that — each one still has to get its own sprite.
		expect(sprites.text.path).toBe(path.join(resources, "cursors", "default", "text.png"));
		expect(sprites["resize-ew"].path).toContain(path.join("cursors", "default"));
		expect(Object.keys(sprites).sort()).toEqual(Object.keys(DEFAULT_CURSOR_SPRITES).sort());
	});

	it("carries each sprite's hotspot as a fraction of its own image", () => {
		const sprites = resolved({ cursor: { theme: "default" } }).cursor.cursorSprites;

		// The whole point of the fraction: it survives the size slider. A hotspot in source
		// pixels would have to be rescaled at draw time, and drifted when it wasn't.
		for (const [type, sprite] of Object.entries<ResolvedSprite>(sprites)) {
			expect(sprite.hotspotX, type).toBeGreaterThanOrEqual(0);
			expect(sprite.hotspotX, type).toBeLessThanOrEqual(1);
			expect(sprite.hotspotY, type).toBeGreaterThanOrEqual(0);
			expect(sprite.hotspotY, type).toBeLessThanOrEqual(1);
		}
		// The arrow's tip is near its top-left corner, nowhere near the centre it used to
		// be drawn from.
		expect(sprites.arrow.hotspotX).toBeLessThan(0.25);
		expect(sprites.arrow.hotspotY).toBeLessThan(0.25);
	});

	it("leaves a custom upload's data: URL untouched — the addon decodes it in memory", () => {
		const dataUrl = "data:image/png;base64,SGkh";
		const out = resolved({ background: { kind: "image", path: dataUrl } });

		expect(out.background.path).toBe(dataUrl);
	});

	it("gives the default theme the built-in arrow, not a placeholder", () => {
		// Regression: "default" used to resolve to no sprite at all, and the compositor drew
		// its dot-and-ring fallback — a dot in a circle where the standard arrow belongs.
		const sprites = resolved({ cursor: { theme: "default" } }).cursor.cursorSprites;

		expect(sprites.arrow.path).toBe(path.join(resources, "cursors", "default", "arrow.png"));
		expect(fs.existsSync(sprites.arrow.path)).toBe(true);
	});

	it("reuses successful packaged cursor probes across changed scenes", () => {
		resolved({ cursor: { theme: "default", size: 1 } });
		const exists = vi.spyOn(fs, "existsSync");
		resolved({ cursor: { theme: "default", size: 2 } });
		expect(exists).not.toHaveBeenCalled();
		exists.mockRestore();
	});

	it("does not cache missing artwork or arbitrary source files", () => {
		const cursor = path.join(resources, "cursors", "default", "arrow.png");
		fs.unlinkSync(cursor);
		expect(resolveSceneAssetPath("cursors/default/arrow.png")).toBeNull();
		fs.writeFileSync(cursor, "png");
		expect(resolveSceneAssetPath("cursors/default/arrow.png")).toBe(cursor);
		const source = path.join(resources, "recording.mp4");
		fs.writeFileSync(source, "source");
		expect(resolveSceneAssetPath("recording.mp4")).toBe(source);
		fs.unlinkSync(source);
		expect(resolveSceneAssetPath("recording.mp4")).toBeNull();
	});

	it("keeps development artwork probes live", () => {
		process.env.VITE_PUBLIC = resources;
		Object.defineProperty(process, "resourcesPath", {
			value: path.join(resources, "runtime"),
			configurable: true,
		});
		const cursor = path.join(resources, "cursors", "default", "arrow.png");
		expect(resolveSceneAssetPath("cursors/default/arrow.png")).toBe(cursor);
		fs.unlinkSync(cursor);
		expect(resolveSceneAssetPath("cursors/default/arrow.png")).toBeNull();
	});

	it("leaves the scene alone when no base dir holds the asset", () => {
		const out = resolved({ background: { kind: "image", path: "/wallpapers/absent.jpg" } });

		expect(out.background.path).toBe("/wallpapers/absent.jpg");
	});
});

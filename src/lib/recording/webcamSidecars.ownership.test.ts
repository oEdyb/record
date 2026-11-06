import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecorderHandle } from "@/hooks/recorderHandle";
import type { NativeMacRecordingRequest } from "@/lib/nativeMacRecording";
import type { RecordingSession } from "@/lib/recordingSession";
import type { RendererIpcMain } from "../../../electron/ipc/trustedRendererIpc";
import type {
	NativeMacCaptureHelper,
	NativeMacRecordingServiceDependencies,
} from "../../../electron/recording/nativeMacRecordingService";
import { NativeMacWebcamClipLedger as ConvertedLedger } from "./webcamSidecars";

const ipcPaths = vi.hoisted(() => ({ data: "", temp: "" }));
vi.mock("electron", () => {
	const noop = () => undefined;
	return {
		app: {
			isPackaged: false,
			getPath: (name: string) => (name === "temp" ? ipcPaths.temp : ipcPaths.data),
			getName: () => "Klippt",
			getVersion: () => "0.0.0",
			on: noop,
			once: noop,
			off: noop,
			whenReady: () => Promise.resolve(),
		},
		BrowserWindow: class {
			static fromWebContents() {
				return null;
			}
			static getAllWindows() {
				return [];
			}
			webContents = { send: vi.fn() };
			isDestroyed() {
				return false;
			}
		},
		clipboard: {},
		desktopCapturer: { getSources: async () => [] },
		dialog: {},
		ipcMain: { handle: noop, on: noop, once: noop, removeAllListeners: noop, removeHandler: noop },
		powerMonitor: { on: noop, off: noop, getCurrentThermalState: () => "nominal" },
		powerSaveBlocker: { start: vi.fn(() => 41), stop: vi.fn() },
		screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({}), on: noop },
		safeStorage: { isEncryptionAvailable: () => false },
		shell: {},
		systemPreferences: {
			getMediaAccessStatus: () => "granted",
			isTrustedAccessibilityClient: vi.fn(() => false),
		},
	};
});
vi.mock("../../../electron/export/sourceHandoffMedia", () => ({
	inspectHandoffSourceMedia: vi.fn(async () => ({
		hasAudio: false,
		roles: [],
		hasKlipptMetadata: false,
		durationSec: 1,
		video: { codec: "h264", width: 16, height: 16, fps: 30 },
	})),
}));
vi.mock("../../../electron/recording/webm-seek-index", () => ({
	reindexRecordingOnDisk: vi.fn(async () => ({ reindexed: false, reason: "no-addon" })),
}));

const output = path.join(os.homedir(), ".cache", "klippt-work", "camera-ledger-tests");
vi.mock("@fix-webm-duration/fix", () => ({ fixWebmDuration: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function fixture(name: string) {
	await fs.mkdir(output, { recursive: true });
	const dir = await fs.mkdtemp(path.join(output, `${name}-`));
	const fileName = "recording-77-clip-0001-webcam.mp4";
	const file = path.join(dir, fileName);
	await fs.writeFile(file, "exact camera original");
	const recorder: RecorderHandle = {
		fileName,
		recorder: { state: "inactive" } as MediaRecorder,
		recordedBlobPromise: Promise.resolve(new Blob()),
		isStreaming: () => true,
		discard: vi.fn(async () => {
			await fs.rename(file, `${file}.discarded`);
		}),
		release: vi.fn(async () => undefined),
	};
	return {
		file,
		recorder,
		clip: { index: 0, durationMs: 1000, screenVideoPath: path.join(dir, "screen.mp4") },
	};
}

async function exists(file: string) {
	return fs.stat(file).then(
		() => true,
		() => false,
	);
}
async function saveEvidence(name: string, data: unknown) {
	console.log(name, JSON.stringify(data));
	await fs.writeFile(path.join(output, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

describe("review B camera lifecycle probes", () => {
	it("B1: a successful attachment arriving during release stays protected from discard", async () => {
		const observations = [];
		for (const [version, Ledger] of [["converted", ConvertedLedger]] as const) {
			const { recorder, file, clip } = await fixture(`B1-${version}`);
			const ledger = new Ledger();
			const gate = deferred<void>();
			vi.mocked(recorder.release).mockImplementation(() => gate.promise);
			ledger.queue({ recorder, clip, webcamOffsetMs: 0 });
			const { webcams } = await ledger.collectKept(new Set([0]));
			const releasing = ledger.releaseUnclaimed();
			await vi.waitFor(() => expect(recorder.release).toHaveBeenCalledOnce());
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			ledger.markSaved(webcams);
			gate.resolve();
			await releasing;
			await ledger.discardUnclaimed();
			observations.push({
				version,
				fileExists: await exists(file),
				discardCalls: vi.mocked(recorder.discard).mock.calls.length,
				warnings: warn.mock.calls,
				retainedOriginal: await fs.readFile(
					(await exists(file)) ? file : `${file}.discarded`,
					"utf8",
				),
			});
			warn.mockRestore();
		}
		await saveEvidence("B1", observations);
		expect(observations[0]?.fileExists, "successfully attached camera must remain owned").toBe(
			true,
		);
	});

	it("B2: explicit discard overlapping release must execute or reject visibly", async () => {
		const observations = [];
		for (const [version, Ledger] of [["converted", ConvertedLedger]] as const) {
			const { recorder, file, clip } = await fixture(`B2-${version}`);
			const ledger = new Ledger();
			const gate = deferred<void>();
			vi.mocked(recorder.release).mockImplementation(() => gate.promise);
			ledger.queue({ recorder, clip, webcamOffsetMs: 0 });
			await ledger.collectKept(new Set([0]));
			const releasing = ledger.releaseUnclaimed();
			await vi.waitFor(() => expect(recorder.release).toHaveBeenCalledOnce());
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const discarding = ledger.discardUnclaimed();
			gate.resolve();
			const result = await Promise.allSettled([releasing, discarding]);
			observations.push({
				version,
				fileExists: await exists(file),
				discardCalls: vi.mocked(recorder.discard).mock.calls.length,
				outcomes: result.map((x) => x.status),
				warnings: warn.mock.calls,
			});
			warn.mockRestore();
		}
		await saveEvidence("B2", observations);
		expect(
			observations[0]?.discardCalls === 1 ||
				observations[0]?.outcomes.includes("rejected") ||
				observations[0]?.warnings.length !== 0,
			"discard must execute, reject, or log conflicting intent",
		).toBe(true);
	});

	it("B3: a camera close failure must retain ownership across clear", async () => {
		const observations = [];
		for (const [version, Ledger] of [["converted", ConvertedLedger]] as const) {
			const { recorder, file, clip } = await fixture(`B3-${version}`);
			const ledger = new Ledger();
			const liveFile = await fs.open(file, "a");
			vi.mocked(recorder.release).mockRejectedValue(new Error("injected close failure"));
			ledger.queue({ recorder, clip, webcamOffsetMs: 0 });
			await ledger.collectKept(new Set([0]));
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const outcome = await Promise.allSettled([ledger.releaseUnclaimed()]);
			const clear = ledger.clear();
			await expect(ledger.releaseUnclaimed()).rejects.toThrow("injected close failure");
			await liveFile.write("; still-open writer after clear");
			observations.push({
				version,
				fileExists: await exists(file),
				clear: clear ?? "void",
				outcome: outcome[0]?.status,
				releaseAttempts: vi.mocked(recorder.release).mock.calls.length,
				remainingCameras: (await ledger.collectKept(new Set([0]))).webcams.length,
				bytes: await fs.readFile(file, "utf8"),
				warnings: warn.mock.calls.map((x) => x[0]),
			});
			await liveFile.close();
			warn.mockRestore();
		}
		await saveEvidence("B3", observations);
		expect(
			observations[0]?.clear,
			"a failed close must prevent clear dropping live ownership",
		).toBe(false);
	});

	it("B4: duplicates join one release and a saved extra cannot be discarded", async () => {
		const { recorder, file, clip } = await fixture("B4");
		const ledger = new ConvertedLedger();
		const gate = deferred<void>();
		vi.mocked(recorder.release).mockImplementation(() => gate.promise);
		ledger.queue({ recorder, clip, webcamOffsetMs: 0 });
		const { webcams } = await ledger.collectKept(new Set([0]));
		const first = ledger.releaseUnclaimed();
		const second = ledger.releaseUnclaimed();
		await vi.waitFor(() => expect(recorder.release).toHaveBeenCalledOnce());
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(ledger.clear()).toBe(false);
		gate.resolve();
		await Promise.all([first, second]);
		ledger.markSaved(webcams);
		await ledger.discardUnclaimed([recorder]);
		expect(await fs.readFile(file, "utf8")).toBe("exact camera original");
		expect(recorder.discard).not.toHaveBeenCalled();
		await saveEvidence("B4", {
			releases: vi.mocked(recorder.release).mock.calls.length,
			discards: vi.mocked(recorder.discard).mock.calls.length,
			bytes: await fs.readFile(file, "utf8"),
			warnings: warn.mock.calls,
		});
	});

	it("B5: actual service Stop and post-Stop IPC attachment preserve handoff, and late attachment cannot resurrect a cleared journal", async () => {
		await fs.mkdir(output, { recursive: true });
		ipcPaths.data = await fs.mkdtemp(path.join(output, "B5-private-ipc-"));
		ipcPaths.temp = await fs.mkdtemp(path.join(output, "B5-private-temp-"));
		const { NativeMacRecordingService } = await import(
			"../../../electron/recording/nativeMacRecordingService"
		);
		const { registerIpcHandlers, consumeCurrentRecordingSession } = await import(
			"../../../electron/ipc/handlers"
		);
		const { nativeMacRecoveryJournalPath } = await import(
			"../../../electron/recording/nativeMacRecoveryJournal"
		);
		const handlers = new Map<string, Parameters<RendererIpcMain["handle"]>[1]>();
		const noop = () => undefined;
		const ipcMain = {
			handle: (channel: string, listener: Parameters<RendererIpcMain["handle"]>[1]) =>
				handlers.set(channel, listener),
			on: noop,
			once: noop,
			removeAllListeners: noop,
			removeHandler: noop,
		} as unknown as RendererIpcMain;
		await registerIpcHandlers(
			noop,
			vi.fn() as never,
			vi.fn() as never,
			vi.fn() as never,
			() => null,
			() => null,
			() => null,
			() => null,
			noop,
			noop,
			() => false,
			{ ipcMain, restoreInterruptedRecording: false, enableCleanVoiceJobs: false },
		);
		const dir = path.join(ipcPaths.data, "recordings");
		const screenVideoPath = path.join(dir, "recording-177-clip-0001.mp4");
		const cameraFileName = "recording-177-clip-0001-webcam.mp4";
		const webcamVideoPath = path.join(dir, cameraFileName);
		const clip = { index: 0, durationMs: 1000, screenVideoPath };
		const journalPath = nativeMacRecoveryJournalPath(dir, 177);
		let firstRecoveryBeforeHelper = false;
		const helper: NativeMacCaptureHelper = {
			captureBounds: null,
			output: "",
			isRunning: () => true,
			kill: vi.fn(async () => undefined),
			waitForStart: vi.fn(async () => {
				await fs.writeFile(screenVideoPath, "screen original");
			}),
			pause: vi.fn(async () => clip),
			reconfigure: vi.fn(async () => undefined),
			resume: vi.fn(async () => 1),
			stop: vi.fn(async () => ({ screenPath: screenVideoPath, clips: [clip] })),
		};
		const request = {
			schemaVersion: 1,
			recordingId: 177,
			platform: "linux",
			source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
			video: { fps: 30, width: 16, height: 16, hideSystemCursor: false },
			audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
			webcam: { enabled: false },
			cursor: { mode: "system" },
			outputs: { screenPath: screenVideoPath },
		} as NativeMacRecordingRequest;
		const deps: NativeMacRecordingServiceDependencies = {
			recordingsDir: dir,
			now: () => 177,
			findHelperPath: async () => "/private/fake-helper",
			freeDiskBytes: async () => 100_000_000_000,
			createHelper: () => {
				firstRecoveryBeforeHelper = true;
				return helper;
			},
			resolveCapture: () => ({ config: request, cursorCaptureMode: "system" }),
			prepareCapturePermissions: async () => undefined,
			onStartStage: (stage) => {
				if (stage === "recovery-saved") firstRecoveryBeforeHelper = true;
			},
			startCursor: async () => true,
			stopCursor: async () => undefined,
			clearCursor: noop,
			finalizeCursor: async () => undefined,
			registerMediaLinks: async () => undefined,
			onSessionStored: noop,
			onRecordingStateChange: noop,
			onFatalError: noop,
		};
		deps.createHelper = () => {
			const stored = JSON.parse(readFileSync(journalPath, "utf8"));
			if (!firstRecoveryBeforeHelper || stored.session.createdAt !== 177)
				throw new Error("helper began before journal");
			return helper;
		};
		const service = new NativeMacRecordingService(deps);
		expect(await service.start(request)).toMatchObject({ success: true });
		expect(await exists(journalPath)).toBe(true);
		const stopped = await service.stop();
		expect(stopped).toMatchObject({ success: true });
		const attach = handlers.get("attach-native-mac-clip-webcams");
		if (!attach) throw new Error("missing camera handler");
		const payload = {
			recordingId: 177,
			screenVideoPath,
			webcams: [
				{
					clipIndex: 0,
					webcam: {
						fileName: cameraFileName,
						videoData: new TextEncoder().encode("exact ipc camera original").buffer,
					},
					durationMs: 1000,
					webcamOffsetMs: 23,
				},
			],
		};
		const first = await Reflect.apply(attach, undefined, [undefined, payload]);
		expect(first).toMatchObject({ success: true });
		const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
		expect(journal.session.clips[0]).toMatchObject({ webcamVideoPath, webcamOffsetMs: 23 });
		const setSession = handlers.get("set-current-recording-session");
		if (!setSession) throw new Error("missing session handoff handler");
		const enriched: RecordingSession = journal.session;
		expect(await Reflect.apply(setSession, undefined, [undefined, enriched])).toMatchObject({
			success: true,
		});
		const mutationEntered = deferred<void>();
		const allowMutation = deferred<void>();
		const rename = fs.rename.bind(fs);
		const gateJournal = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === journalPath) {
				mutationEntered.resolve();
				await allowMutation.promise;
			}
			return rename(from, to);
		});
		const overlappingAttach = Reflect.apply(attach, undefined, [undefined, payload]);
		await mutationEntered.promise;
		const clearing = consumeCurrentRecordingSession();
		allowMutation.resolve();
		await expect(overlappingAttach).resolves.toMatchObject({ success: true });
		await clearing;
		gateJournal.mockRestore();
		expect(await exists(journalPath)).toBe(false);
		const late = await Reflect.apply(attach, undefined, [undefined, payload]);
		expect(late).toMatchObject({ success: true });
		expect(await Reflect.apply(setSession, undefined, [undefined, enriched])).toMatchObject({
			success: true,
		});
		expect(await exists(journalPath)).toBe(false);
		expect(await fs.readFile(webcamVideoPath, "utf8")).toBe("exact ipc camera original");
		await saveEvidence("B5", {
			firstRecoveryBeforeHelper,
			stopSuccess: stopped.success,
			first,
			journalCamera: journal.session.clips[0].webcamVideoPath,
			overlappingAttachAndClear: "fulfilled",
			late,
			clearedJournalResurrected: await exists(journalPath),
			bytes: await fs.readFile(webcamVideoPath, "utf8"),
		});
	});

	it("B7: a pending camera result is collected while a preserving release waits", async () => {
		const observations = [];
		for (const [version, Ledger] of [["converted", ConvertedLedger]] as const) {
			const { recorder, file, clip } = await fixture(`B7-${version}`);
			const ledger = new Ledger();
			const finalization = deferred<Blob>();
			const close = deferred<void>();
			recorder.recordedBlobPromise = finalization.promise;
			vi.mocked(recorder.release).mockImplementation(() => close.promise);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			ledger.queue({ recorder, clip, webcamOffsetMs: 0 });
			const collecting = ledger.collectKept(new Set([0]));
			const releasing = ledger.releaseUnclaimed();
			finalization.resolve(new Blob());
			const collected = await collecting;
			close.resolve();
			await releasing;
			observations.push({
				version,
				webcams: collected.webcams.length,
				failures: collected.failures.length,
				releaseCalls: vi.mocked(recorder.release).mock.calls.length,
				bytes: await fs.readFile(file, "utf8"),
				warnings: warn.mock.calls,
			});
			warn.mockRestore();
		}
		await saveEvidence("B7", observations);
		expect(
			observations[0]?.webcams,
			"a release that preserves bytes must not silently suppress a finalized kept camera",
		).toBe(1);
	});
});

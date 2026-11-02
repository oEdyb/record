import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, desktopCapturer, powerMonitor, systemPreferences } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRecordingSession, type RecordingSession } from "../../src/lib/recordingSession";
import { inspectHandoffSourceMedia } from "../export/sourceHandoffMedia";
import type { NativeMacRecordingServiceDependencies } from "../recording/nativeMacRecordingService";
import { persistNativeMacRecoveryJournal } from "../recording/nativeMacRecoveryJournal";
import type { RendererIpcMain } from "./trustedRendererIpc";

const paths = vi.hoisted(() => ({ userData: "", temp: "" }));
const powerBlocker = vi.hoisted(() => ({ start: vi.fn(() => 41), stop: vi.fn() }));

vi.mock("electron", () => {
	const noop = () => undefined;
	return {
		app: {
			isPackaged: false,
			getPath: (name: string) => (name === "temp" ? paths.temp : paths.userData),
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
		desktopCapturer: { getSources: () => Promise.resolve([]) },
		dialog: {},
		ipcMain: { handle: noop, on: noop, once: noop, removeAllListeners: noop, removeHandler: noop },
		powerMonitor: { on: noop, off: noop, getCurrentThermalState: () => "nominal" },
		powerSaveBlocker: powerBlocker,
		screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({}), on: noop },
		safeStorage: { isEncryptionAvailable: () => false },
		shell: {},
		systemPreferences: {
			getMediaAccessStatus: () => "granted",
			isTrustedAccessibilityClient: vi.fn(() => false),
		},
	};
});

vi.mock("../export/sourceHandoffMedia", () => ({ inspectHandoffSourceMedia: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function pinPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function fakeIpcMain() {
	const channels = new Set<string>();
	const handlers = new Map<string, Parameters<RendererIpcMain["handle"]>[1]>();
	const ipcMain: RendererIpcMain = {
		handle: (channel: string, listener: Parameters<RendererIpcMain["handle"]>[1]) => {
			channels.add(channel);
			handlers.set(channel, listener);
		},
		on: (channel: string) => {
			channels.add(channel);
			return ipcMain;
		},
		once: (channel: string) => {
			channels.add(channel);
			return ipcMain;
		},
		removeAllListeners: () => ipcMain,
		removeHandler: () => undefined,
	} as unknown as RendererIpcMain;
	return { ipcMain, channels, handlers };
}

async function register(
	options: Parameters<typeof import("./handlers").registerIpcHandlers>[11] = {},
	mainWindow?: BrowserWindow,
) {
	const { registerIpcHandlers } = await import("./handlers");
	const { ipcMain, channels, handlers } = fakeIpcMain();
	const recovery = registerIpcHandlers(
		vi.fn(),
		vi.fn() as never,
		vi.fn() as never,
		vi.fn() as never,
		() => mainWindow ?? null,
		() => null,
		() => null,
		() => null,
		vi.fn(),
		vi.fn(),
		() => false,
		{ ...options, enableCleanVoiceJobs: false, ipcMain },
	);
	return { recovery, channels, handlers };
}

async function journalInterruptedTake(clip: { provisionalDuration?: true } = {}) {
	const recordingsDir = path.join(paths.userData, "recordings");
	await fs.mkdir(recordingsDir, { recursive: true });
	const screenVideoPath = path.join(recordingsDir, "recording-77-clip-0001.mp4");
	await fs.writeFile(screenVideoPath, "durable fragment");
	const session: RecordingSession = {
		schemaVersion: 2,
		createdAt: 77,
		screenVideoPath,
		clips: [{ index: 0, screenVideoPath, durationMs: 2_000, ...clip }],
	};
	await persistNativeMacRecoveryJournal(recordingsDir, session);
}

describe("registerIpcHandlers startup contract", () => {
	it("keeps optional Accessibility non-prompting across repeated Record requests", async () => {
		pinPlatform("darwin");
		const { handlers } = await register();
		const request = handlers.get("request-native-mac-cursor-access");
		if (!request) throw new Error("Cursor access IPC missing");
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(Reflect.apply(request, undefined, [{}])).resolves.toMatchObject({
				granted: false,
			});
		}
		expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
		expect(systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
	});
	beforeEach(async () => {
		vi.resetModules();
		paths.userData = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-handlers-user-"));
		paths.temp = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-handlers-temp-"));
		const { inspectHandoffSourceMedia: inspect } = await import("../export/sourceHandoffMedia");
		vi.mocked(inspect).mockResolvedValue({
			hasAudio: false,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 2,
			video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
		});
	});

	afterEach(async () => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		await fs.rm(paths.userData, { recursive: true, force: true, maxRetries: 5 });
		await fs.rm(paths.temp, { recursive: true, force: true, maxRetries: 5 });
		vi.mocked(inspectHandoffSourceMedia).mockReset();
		powerBlocker.start.mockClear();
		powerBlocker.stop.mockClear();
	});

	it("has every renderer channel registered before the recovery check settles", async () => {
		pinPlatform("darwin");
		await journalInterruptedTake();

		const { recovery, channels } = await register();

		expect(recovery).toBeInstanceOf(Promise);
		expect(channels.size).toBeGreaterThan(20);
		await recovery;
	});

	it.each([
		"prepare-native-linux-recording",
		"start-native-linux-recording",
		"start-native-mac-recording",
	])("waits for startup recovery before %s can create a new take", async (channel) => {
		pinPlatform("linux");
		await journalInterruptedTake({ provisionalDuration: true });
		let inspectionStarted: (() => void) | undefined;
		const inspectionEntered = new Promise<void>((resolve) => {
			inspectionStarted = resolve;
		});
		let finishInspection: (() => void) | undefined;
		const inspectionGate = new Promise<void>((resolve) => {
			finishInspection = resolve;
		});
		const { inspectHandoffSourceMedia: inspect } = await import("../export/sourceHandoffMedia");
		vi.mocked(inspect).mockImplementation(async () => {
			inspectionStarted?.();
			await inspectionGate;
			return {
				hasAudio: false,
				hasKlipptMetadata: false,
				roles: [],
				durationSec: 2,
				video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
			};
		});
		const { NativeMacRecordingService } = await import("../recording/nativeMacRecordingService");
		const prepare = vi
			.spyOn(NativeMacRecordingService.prototype, "prepare")
			.mockResolvedValue({ success: false, error: "capture probe" });
		const start = vi
			.spyOn(NativeMacRecordingService.prototype, "start")
			.mockResolvedValue({ success: false, error: "capture probe" });
		const { recovery, handlers } = await register();
		await inspectionEntered;
		const invoke = handlers.get(channel);
		if (!invoke) throw new Error("Capture IPC missing");
		const capture = Reflect.apply(invoke, undefined, [
			{},
			{
				schemaVersion: 1,
				audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
				video: { fps: 60 },
				webcam: { enabled: false },
			},
		]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			expect(prepare).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
		} finally {
			finishInspection?.();
		}
		await expect(recovery).resolves.toBe(true);
		await expect(capture).resolves.toMatchObject({ success: false, error: "capture probe" });
		expect(prepare.mock.calls.length + start.mock.calls.length).toBe(1);
		prepare.mockRestore();
		start.mockRestore();
	});

	it.each([
		"linux",
		"darwin",
	] as const)("passes %s capture identity to Studio through shared Start and Continue IPC", async (platform) => {
		pinPlatform(platform);
		const serviceModule = await import("../recording/nativeMacRecordingService");
		const metadataModule = await import("../recording/linuxClipCaptureMetadata");
		const Service = serviceModule.NativeMacRecordingService;
		const Metadata = metadataModule.LinuxClipCaptureMetadata;
		let dependencies: NativeMacRecordingServiceDependencies | undefined;
		const serviceConstructor = vi
			.spyOn(serviceModule, "NativeMacRecordingService")
			.mockImplementation(
				class extends Service {
					constructor(deps: NativeMacRecordingServiceDependencies) {
						super(deps);
						dependencies = deps;
						this.isCapturing = () => false;
					}
				},
			);
		const metadataConstructor = vi
			.spyOn(metadataModule, "LinuxClipCaptureMetadata")
			.mockImplementation(
				class extends Metadata {
					constructor(max: number, start: number) {
						super(max, start);
						this.sourceKind = "window";
						this.pipeWireNodeId = 91;
					}
				},
			);
		const start = vi
			.spyOn(Service.prototype, "start")
			.mockResolvedValue({ success: false, error: "capture probe" });
		const resume = vi
			.spyOn(Service.prototype, "resume")
			.mockResolvedValue({ success: false, error: "capture probe" });
		const beforeCapture = vi.fn(async () => undefined);
		try {
			const { recovery, handlers } = await register({
				restoreInterruptedRecording: false,
				beforeCapture,
			});
			await recovery;
			// The service is created lazily by a transport request.
			const pause = handlers.get("pause-native-mac-recording");
			if (!pause) throw new Error("Pause IPC missing");
			await Reflect.apply(pause, undefined, [{}]);
			if (!dependencies) throw new Error("Service dependencies missing");
			if (platform === "linux") await dependencies.startCursor(1000);
			for (const channel of ["start-native-mac-recording", "resume-native-mac-recording"]) {
				const invoke = handlers.get(channel);
				if (!invoke) throw new Error("Capture IPC missing");
				await Reflect.apply(invoke, undefined, [
					{},
					{ video: { fps: 30 }, webcam: { enabled: false } },
				]);
				expect(beforeCapture).toHaveBeenLastCalledWith(
					platform === "linux"
						? { pipeWireNodeId: 91, windowSource: true }
						: { pipeWireNodeId: undefined, windowSource: false },
				);
			}
		} finally {
			serviceConstructor.mockRestore();
			metadataConstructor.mockRestore();
			start.mockRestore();
			resume.mockRestore();
		}
	});

	it("cancels Linux Start while the recorder unmap delay is pending", async () => {
		pinPlatform("linux");
		const { NativeMacRecordingService } = await import("../recording/nativeMacRecordingService");
		const start = vi
			.spyOn(NativeMacRecordingService.prototype, "start")
			.mockResolvedValue({ success: false, error: "unexpected start" });
		let hidden: (() => void) | undefined;
		const hideEntered = new Promise<void>((resolve) => {
			hidden = resolve;
		});
		const window = Object.assign(new BrowserWindow(), {
			hide: () => hidden?.(),
			show: vi.fn(),
			focus: vi.fn(),
		});
		try {
			const { recovery, handlers } = await register({ restoreInterruptedRecording: false }, window);
			await recovery;
			const invokeStart = handlers.get("start-native-mac-recording");
			const cancel = handlers.get("cancel-native-linux-prepare");
			if (!invokeStart || !cancel) throw new Error("Capture IPC missing");
			const capture = Reflect.apply(invokeStart, undefined, [
				{},
				{ schemaVersion: 1, platform: "linux", video: { fps: 60 }, webcam: { enabled: false } },
			]);
			await hideEntered;
			await Reflect.apply(cancel, undefined, [{}]);
			await expect(capture).resolves.toMatchObject({
				success: false,
				error: "Recording start cancelled.",
			});
			expect(start).not.toHaveBeenCalled();
		} finally {
			start.mockRestore();
		}
	});

	it("routes Linux suspend through the existing recording interruption notification", async () => {
		pinPlatform("linux");
		const listen = vi.spyOn(powerMonitor, "on");
		const { NativeMacRecordingService } = await import("../recording/nativeMacRecordingService");
		const running = vi
			.spyOn(NativeMacRecordingService.prototype, "isRunning")
			.mockReturnValue(true);
		try {
			const window = new BrowserWindow();
			const { recovery } = await register({}, window);
			await recovery;
			const suspend = listen.mock.calls.find(([event]) => ["suspend"].includes(event));
			if (!suspend) throw new Error("Linux suspend listener missing");
			Reflect.apply(suspend[1], undefined, []);
			expect(window.webContents.send).toHaveBeenCalledWith(
				"native-mac-recording-interrupted",
				"system-sleep",
			);
			expect(listen.mock.calls.some(([event]) => ["lock-screen"].includes(event))).toBe(false);
		} finally {
			running.mockRestore();
			listen.mockRestore();
		}
	});

	it("reports an interrupted native take left in the recovery journal", async () => {
		pinPlatform("darwin");
		await journalInterruptedTake();

		const { recovery } = await register();

		await expect(recovery).resolves.toBe(true);
	});

	it("never enumerates Electron sources on Linux, including startup and explicit refresh", async () => {
		pinPlatform("linux");
		const enumerate = vi.spyOn(desktopCapturer, "getSources");
		const { recovery, handlers } = await register();
		await recovery;
		const readSources = handlers.get("get-sources");
		if (!readSources) throw new Error("get-sources IPC was not registered");
		await expect(
			Reflect.apply(readSources, undefined, [
				undefined,
				{ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } },
			]),
		).resolves.toEqual([]);
		expect(enumerate).not.toHaveBeenCalled();
		enumerate.mockRestore();
	});

	it("preserves cursor telemetry within a take and releases it after the terminal snapshot", async () => {
		pinPlatform("linux");
		const serviceModule = await import("../recording/nativeMacRecordingService");
		const { PipeWireCursorAccumulator } = await import(
			"../native-bridge/cursor/recording/pipeWireCursorAccumulator"
		);
		const Service = serviceModule.NativeMacRecordingService;
		let dependencies: NativeMacRecordingServiceDependencies | undefined;
		const serviceConstructor = vi
			.spyOn(serviceModule, "NativeMacRecordingService")
			.mockImplementation(
				class extends Service {
					constructor(deps: NativeMacRecordingServiceDependencies) {
						super(deps);
						dependencies = deps;
						this.isCapturing = () => false;
					}
				},
			);
		const snapshots = vi.spyOn(PipeWireCursorAccumulator.prototype, "toRecordingData");
		try {
			const { recovery, handlers } = await register({ restoreInterruptedRecording: false });
			await recovery;
			const pause = handlers.get("pause-native-mac-recording");
			if (!pause) throw new Error("Pause IPC missing");
			await Reflect.apply(pause, undefined, [{}]);
			if (!dependencies) throw new Error("Service dependencies missing");
			await dependencies.startCursor(1000);
			await dependencies.startCursor(1500);
			await dependencies.stopCursor();
			const first = snapshots.mock.contexts[0];
			if (!(first instanceof PipeWireCursorAccumulator))
				throw new Error("First cursor snapshot missing");
			first.addSample({
				event: "cursor-sample",
				timestampMs: 1100,
				x: 10,
				y: 10,
				width: 100,
				height: 100,
				visible: true,
			});
			expect(first.toRecordingData().samples[0]?.timeMs).toBe(100);
			await dependencies.startCursor(2000);
			await dependencies.stopCursor();
			const second = snapshots.mock.contexts.at(-1);
			if (!(second instanceof PipeWireCursorAccumulator))
				throw new Error("Second cursor snapshot missing");
			expect(second).not.toBe(first);
			expect(second.toRecordingData().samples).toEqual([]);
			second.addSample({
				event: "cursor-sample",
				timestampMs: 2100,
				x: 20,
				y: 20,
				width: 100,
				height: 100,
				visible: true,
			});
			expect(second.toRecordingData().samples[0]?.timeMs).toBe(100);
		} finally {
			serviceConstructor.mockRestore();
			snapshots.mockRestore();
		}
	});

	it("keeps the outer quit guard active after native Stop until its owning renderer acknowledges", async () => {
		pinPlatform("linux");
		const { recovery, handlers } = await register();
		await recovery;
		const { NativeMacRecordingService } = await import("../recording/nativeMacRecordingService");
		const { isNativeMacCaptureRunning } = await import("./handlers");
		const start = vi
			.spyOn(NativeMacRecordingService.prototype, "start")
			.mockResolvedValue({ success: true, recordingId: 77 });
		const invokeStart = handlers.get("start-native-mac-recording");
		const invokeAck = handlers.get("acknowledge-native-recording-app-stop");
		if (!invokeStart || !invokeAck) throw new Error("Recording IPC was not registered");
		const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
		const result: unknown = await Reflect.apply(invokeStart, undefined, [
			{ sender: owner },
			{ video: { fps: 60 }, webcam: { enabled: false } },
		]);
		if (!result || typeof result !== "object" || !("rendererStop" in result))
			throw new Error("The start response had no renderer take token");
		expect(isNativeMacCaptureRunning()).toBe(true);
		const request = result.rendererStop;
		if (!request || typeof request !== "object") throw new Error("Invalid renderer take token");
		const other = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
		const choose = vi
			.spyOn(NativeMacRecordingService.prototype, "selectSource")
			.mockResolvedValue({ success: false, cancelled: true });
		const invokeChoose = handlers.get("select-native-linux-source");
		if (!invokeChoose) throw new Error("Source selection IPC missing");
		for (const [sender, selectionOwner] of [
			[other, request],
			[owner, { ...request, token: "stale-token" }],
			[owner, { ...request, recordingId: 78 }],
			[owner, null],
		]) {
			await expect(
				Reflect.apply(invokeChoose, undefined, [{ sender }, selectionOwner]),
			).resolves.toMatchObject({ success: false });
		}
		expect(choose).not.toHaveBeenCalled();
		await expect(
			Reflect.apply(invokeChoose, undefined, [{ sender: owner }, request, "invalid"]),
		).resolves.toMatchObject({ success: false, error: "Invalid cursor mode." });
		expect(choose).not.toHaveBeenCalled();
		await expect(
			Reflect.apply(invokeChoose, undefined, [{ sender: owner }, request, "system"]),
		).resolves.toEqual({ success: false, cancelled: true });
		expect(choose).toHaveBeenCalledOnce();
		expect(choose).toHaveBeenCalledWith("system");
		choose.mockRestore();

		expect(
			Reflect.apply(invokeAck, undefined, [{ sender: other }, { ...request, success: true }]),
		).toEqual({ success: false });
		expect(isNativeMacCaptureRunning()).toBe(true);
		expect(
			Reflect.apply(invokeAck, undefined, [{ sender: owner }, { ...request, success: true }]),
		).toEqual({ success: true });
		expect(isNativeMacCaptureRunning()).toBe(false);
		start.mockRestore();
	});

	it("persists per-clip camera paths and offsets in the canonical manifest before attachment succeeds", async () => {
		pinPlatform("linux");
		const { handlers, recovery } = await register({ restoreInterruptedRecording: false });
		await recovery;
		const recordingsDir = path.join(paths.userData, "recordings");
		await fs.mkdir(recordingsDir, { recursive: true });
		const clips = [0, 1, 2].map((index) => ({
			index,
			screenVideoPath: path.join(
				recordingsDir,
				`recording-77-clip-${String(index + 1).padStart(4, "0")}.mp4`,
			),
			durationMs: 1_000 + index,
			...(index === 2 ? { removed: true } : {}),
		}));
		const first = clips[0];
		if (!first) throw new Error("Missing screen clip");
		const session: RecordingSession = {
			schemaVersion: 2,
			createdAt: 77,
			screenVideoPath: first.screenVideoPath,
			cursorCaptureMode: "system",
			clips,
		};
		const manifestPath = path.join(recordingsDir, "recording-77.session.json");
		await fs.writeFile(manifestPath, JSON.stringify(session));
		await Promise.all(
			clips.map((clip) => fs.writeFile(clip.screenVideoPath, `screen bytes ${clip.index}`)),
		);
		await persistNativeMacRecoveryJournal(recordingsDir, session);
		const attach = handlers.get("attach-native-mac-clip-webcams");
		if (!attach) throw new Error("Camera attachment IPC was not registered");
		const webcams = [1, 0].map((clipIndex) => ({
			clipIndex,
			webcam: {
				fileName: `recording-77-clip-${String(clipIndex + 1).padStart(4, "0")}-webcam.webm`,
				videoData: new Uint8Array([clipIndex + 1, 2, 3]).buffer,
			},
			durationMs: 1_000,
			webcamOffsetMs: clipIndex === 0 ? 12 : 34,
		}));
		const result: unknown = await Reflect.apply(attach, undefined, [
			undefined,
			{ recordingId: 77, screenVideoPath: first.screenVideoPath, webcams },
		]);
		expect(result).toMatchObject({ success: true });
		const stored = normalizeRecordingSession(JSON.parse(await fs.readFile(manifestPath, "utf8")));
		expect(stored?.clips?.[0]).toMatchObject({
			...clips[0],
			webcamVideoPath: path.join(recordingsDir, "recording-77-clip-0001-webcam.webm"),
			webcamOffsetMs: 12,
		});
		expect(stored?.clips?.[1]).toMatchObject({
			...clips[1],
			webcamVideoPath: path.join(recordingsDir, "recording-77-clip-0002-webcam.webm"),
			webcamOffsetMs: 34,
		});
		expect(stored?.clips?.[2]).toEqual(clips[2]);
		expect(result).toMatchObject({ session: stored });
		const journal = JSON.parse(
			await fs.readFile(path.join(recordingsDir, "recording-77.recovery.json"), "utf8"),
		);
		expect(journal.session.clips).toEqual(stored?.clips);
	});

	it("attaches streamed MP4 bytes without invoking the Matroska remux or duration patch", async () => {
		pinPlatform("linux");
		const { handlers, recovery } = await register({ restoreInterruptedRecording: false });
		await recovery;
		const { CompositorViewService } = await import(
			"../native-bridge/services/compositorViewService"
		);
		const durationPatch = await import("../recording/webm-duration");
		const remux = vi
			.spyOn(CompositorViewService.prototype, "remuxSeekable")
			.mockResolvedValue(null);
		const patch = vi.spyOn(durationPatch, "patchWebmDurationOnDisk");
		try {
			const recordingsDir = path.join(paths.userData, "recordings");
			await fs.mkdir(recordingsDir, { recursive: true });
			const screenVideoPath = path.join(recordingsDir, "recording-77-clip-0001.mp4");
			const fileName = "recording-77-clip-0001-webcam.mp4";
			await fs.writeFile(screenVideoPath, "screen bytes");
			await fs.writeFile(
				path.join(recordingsDir, "recording-77.session.json"),
				JSON.stringify({
					createdAt: 77,
					screenVideoPath,
					clips: [{ index: 0, screenVideoPath, durationMs: 1000 }],
				}),
			);
			const open = handlers.get("open-recording-stream");
			const append = handlers.get("append-recording-chunk");
			const attach = handlers.get("attach-native-mac-clip-webcams");
			if (!open || !append || !attach) throw new Error("Recording IPC missing");
			await expect(Reflect.apply(open, undefined, [undefined, fileName])).resolves.toMatchObject({
				success: true,
			});
			const bytes = new TextEncoder().encode("ftyp moov moof mdat exact camera bytes");
			await expect(
				Reflect.apply(append, undefined, [undefined, fileName, bytes.buffer]),
			).resolves.toMatchObject({ success: true });
			await expect(
				Reflect.apply(attach, undefined, [
					undefined,
					{
						recordingId: 77,
						screenVideoPath,
						webcams: [
							{
								clipIndex: 0,
								webcam: { fileName, videoData: new ArrayBuffer(0) },
								durationMs: 1000,
								webcamOffsetMs: 15,
							},
						],
					},
				]),
			).resolves.toMatchObject({
				success: true,
				session: {
					clips: [{ webcamVideoPath: path.join(recordingsDir, fileName), webcamOffsetMs: 15 }],
				},
			});
			expect(remux).not.toHaveBeenCalled();
			expect(patch).not.toHaveBeenCalled();
			expect(await fs.readFile(path.join(recordingsDir, fileName))).toEqual(Buffer.from(bytes));
		} finally {
			remux.mockRestore();
			patch.mockRestore();
		}
	});

	it.each([
		undefined,
		"webm",
		"mp4",
	])("accepts %s camera metadata only from the current take's owning HUD", async (container) => {
		pinPlatform("linux");
		const { recovery, handlers } = await register();
		await recovery;
		const { NativeMacRecordingService } = await import("../recording/nativeMacRecordingService");
		const start = vi
			.spyOn(NativeMacRecordingService.prototype, "start")
			.mockResolvedValue({ success: true, recordingId: 77 });
		const registerCamera = vi
			.spyOn(NativeMacRecordingService.prototype, "registerRendererWebcam")
			.mockResolvedValue(true);
		const invokeStart = handlers.get("start-native-mac-recording");
		const invokeRegister = handlers.get("register-native-recording-webcam");
		const invokeAck = handlers.get("acknowledge-native-recording-app-stop");
		if (!invokeStart || !invokeRegister || !invokeAck) throw new Error("Recording IPC missing");
		const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
		const other = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
		const result: unknown = await Reflect.apply(invokeStart, undefined, [
			{ sender: owner },
			{ video: { fps: 60 }, webcam: { enabled: false } },
		]);
		if (
			!result ||
			typeof result !== "object" ||
			!("rendererStop" in result) ||
			!result.rendererStop ||
			typeof result.rendererStop !== "object"
		)
			throw new Error("No renderer token");
		const request = result.rendererStop;
		const metadata = {
			...request,
			clipIndex: 0,
			offsetMs: 23.5,
			...(container ? { container } : {}),
		};
		await expect(
			Reflect.apply(invokeRegister, undefined, [{ sender: other }, metadata]),
		).resolves.toMatchObject({ success: false });
		await expect(
			Reflect.apply(invokeRegister, undefined, [{ sender: owner }, { ...metadata, clipIndex: -1 }]),
		).resolves.toMatchObject({ success: false });
		expect(registerCamera).not.toHaveBeenCalled();
		await expect(
			Reflect.apply(invokeRegister, undefined, [{ sender: owner }, metadata]),
		).resolves.toEqual({ success: true, registered: true });
		expect(registerCamera).toHaveBeenCalledExactlyOnceWith(77, {
			clipIndex: 0,
			key: "webcamVideoPath",
			path: path.join(
				paths.userData,
				"recordings",
				`recording-77-clip-0001-webcam.${container ?? "webm"}`,
			),
			offsetMs: 23.5,
		});
		Reflect.apply(invokeAck, undefined, [{ sender: owner }, { ...request, success: true }]);
		await expect(
			Reflect.apply(invokeRegister, undefined, [{ sender: owner }, metadata]),
		).resolves.toMatchObject({ success: false });
		registerCamera.mockRestore();
		start.mockRestore();
	});

	it("reports attachment failure when the durable manifest cannot be committed", async () => {
		pinPlatform("linux");
		const { handlers, recovery } = await register({ restoreInterruptedRecording: false });
		await recovery;
		const recordingsDir = path.join(paths.userData, "recordings");
		await fs.mkdir(recordingsDir, { recursive: true });
		const screenVideoPath = path.join(recordingsDir, "recording-77-clip-0001.mp4");
		const session: RecordingSession = {
			schemaVersion: 2,
			createdAt: 77,
			screenVideoPath,
			clips: [{ index: 0, screenVideoPath, durationMs: 1_000 }],
		};
		const manifestPath = path.join(recordingsDir, "recording-77.session.json");
		await fs.writeFile(screenVideoPath, "screen bytes");
		await fs.writeFile(manifestPath, JSON.stringify(session));
		const rename = fs.rename.bind(fs);
		const failManifest = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === manifestPath) throw new Error("Manifest commit failed");
			return rename(from, to);
		});
		try {
			const attach = handlers.get("attach-native-mac-clip-webcams");
			if (!attach) throw new Error("Camera attachment IPC was not registered");
			const result: unknown = await Reflect.apply(attach, undefined, [
				undefined,
				{
					recordingId: 77,
					screenVideoPath,
					webcams: [
						{
							clipIndex: 0,
							webcam: {
								fileName: "recording-77-clip-0001-webcam.webm",
								videoData: new Uint8Array([1, 2, 3]).buffer,
							},
							durationMs: 1_000,
							webcamOffsetMs: 12,
						},
					],
				},
			]);
			expect(result).toMatchObject({ success: false, error: "Manifest commit failed" });
			expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toEqual(session);
		} finally {
			failManifest.mockRestore();
		}
	});

	it("restores an interrupted Linux clip session through the shared recovery journal", async () => {
		pinPlatform("linux");
		await journalInterruptedTake();
		const { recovery } = await register();
		await expect(recovery).resolves.toBe(true);
	});

	it("reports nothing to recover on a clean start", async () => {
		pinPlatform("darwin");

		const { recovery } = await register();

		await expect(recovery).resolves.toBe(false);
	});

	it("does not enable the clip-native recovery path on Windows yet", async () => {
		pinPlatform("win32");
		await journalInterruptedTake();

		const { recovery } = await register();

		await expect(recovery).resolves.toBe(false);
	});

	it("keeps starting when the diagnostics folder cannot be created", async () => {
		pinPlatform("darwin");
		await fs.writeFile(path.join(paths.userData, "diagnostics"), "not a folder");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const { recovery } = await register();

		await expect(recovery).resolves.toBe(false);
		await vi.waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				"[diagnostics] workload telemetry startup failed:",
				expect.anything(),
			),
		);
		warn.mockRestore();
	});

	it("skips the recovery scan when the caller turns it off", async () => {
		pinPlatform("darwin");
		await journalInterruptedTake();

		const { recovery } = await register({ restoreInterruptedRecording: false });

		await expect(recovery).resolves.toBe(false);
	});

	it.each([
		["linux", 1, 1],
		["darwin", 0, 0],
	] as const)("on %s, the recording state holds the display awake only for Linux", async (platform, starts, stops) => {
		pinPlatform(platform);
		const { handlers } = await register();
		const setRecordingState = handlers.get("set-recording-state");
		if (!setRecordingState) throw new Error("set-recording-state missing");

		await Reflect.apply(setRecordingState, undefined, [{}, true, 5, "system"]);
		await Reflect.apply(setRecordingState, undefined, [{}, true, 5, "system"]);
		expect(powerBlocker.start).toHaveBeenCalledTimes(starts);
		if (starts) expect(powerBlocker.start).toHaveBeenCalledWith("prevent-display-sleep");

		await Reflect.apply(setRecordingState, undefined, [{}, false, 5, "system"]);
		expect(powerBlocker.stop).toHaveBeenCalledTimes(stops);
		if (stops) expect(powerBlocker.stop).toHaveBeenCalledWith(41);
	});
});

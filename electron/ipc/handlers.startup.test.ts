import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingSession } from "../../src/lib/recordingSession";
import { inspectHandoffSourceMedia } from "../export/sourceHandoffMedia";
import { persistNativeMacRecoveryJournal } from "../recording/nativeMacRecoveryJournal";
import type { RendererIpcMain } from "./trustedRendererIpc";

const paths = vi.hoisted(() => ({ userData: "", temp: "" }));

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
		BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
		clipboard: {},
		desktopCapturer: { getSources: () => Promise.resolve([]) },
		dialog: {},
		ipcMain: { handle: noop, on: noop, once: noop, removeAllListeners: noop, removeHandler: noop },
		powerMonitor: { on: noop, off: noop, getCurrentThermalState: () => "nominal" },
		screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({}), on: noop },
		safeStorage: { isEncryptionAvailable: () => false },
		shell: {},
		systemPreferences: { getMediaAccessStatus: () => "granted" },
	};
});

vi.mock("../export/sourceHandoffMedia", () => ({ inspectHandoffSourceMedia: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function pinPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function fakeIpcMain() {
	const channels = new Set<string>();
	const ipcMain: RendererIpcMain = {
		handle: (channel: string) => void channels.add(channel),
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
	return { ipcMain, channels };
}

async function register(options: { restoreInterruptedRecording?: boolean } = {}) {
	const { registerIpcHandlers } = await import("./handlers");
	const { ipcMain, channels } = fakeIpcMain();
	const recovery = registerIpcHandlers(
		vi.fn(),
		vi.fn() as never,
		vi.fn() as never,
		vi.fn() as never,
		() => null,
		() => null,
		() => null,
		() => null,
		vi.fn(),
		vi.fn(),
		() => false,
		{ ...options, enableCleanVoiceJobs: false, ipcMain },
	);
	return { recovery, channels };
}

async function journalInterruptedTake() {
	const recordingsDir = path.join(paths.userData, "recordings");
	await fs.mkdir(recordingsDir, { recursive: true });
	const screenVideoPath = path.join(recordingsDir, "recording-77-clip-0001.mp4");
	await fs.writeFile(screenVideoPath, "durable fragment");
	const session: RecordingSession = {
		schemaVersion: 2,
		createdAt: 77,
		screenVideoPath,
		clips: [{ index: 0, screenVideoPath, durationMs: 2_000 }],
	};
	await persistNativeMacRecoveryJournal(recordingsDir, session);
}

describe("registerIpcHandlers startup contract", () => {
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
	});

	it("has every renderer channel registered before the recovery check settles", async () => {
		pinPlatform("darwin");
		await journalInterruptedTake();

		const { recovery, channels } = await register();

		expect(recovery).toBeInstanceOf(Promise);
		expect(channels.size).toBeGreaterThan(20);
		await recovery;
	});

	it("reports an interrupted native take left in the recovery journal", async () => {
		pinPlatform("darwin");
		await journalInterruptedTake();

		const { recovery } = await register();

		await expect(recovery).resolves.toBe(true);
	});

	it("reports nothing to recover on a clean start", async () => {
		pinPlatform("darwin");

		const { recovery } = await register();

		await expect(recovery).resolves.toBe(false);
	});

	it("never offers a native-take recovery off macOS", async () => {
		pinPlatform("linux");
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
});

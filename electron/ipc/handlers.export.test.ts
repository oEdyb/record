import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CURSOR_SPRITES } from "../../src/lib/cursor/cursorThemes";
import type { CompositorViewAddon } from "../native/compositor-view/addon";
import type { ExportSourceMetadata } from "../native-bridge/services/compositorViewService";
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

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
type WriteResult = { success: boolean; message?: string; error?: string };

function fakeIpcMain() {
	const channels = new Set<string>();
	const handlers = new Map<string, IpcHandler>();
	const ipcMain: RendererIpcMain = {
		handle: (channel: string, handler: IpcHandler) => {
			channels.add(channel);
			handlers.set(channel, handler);
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
	const invoke = async (channel: string, event: unknown, ...args: unknown[]): Promise<unknown> => {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`No handler registered for ${channel}`);
		return await handler(event, ...args);
	};
	return { ipcMain, invoke };
}

async function register(addon: CompositorViewAddon) {
	const { CompositorViewService } = await import("../native-bridge/services/compositorViewService");
	const servicePrototype = CompositorViewService.prototype as unknown as {
		ensureAddon: () => CompositorViewAddon;
	};
	vi.spyOn(servicePrototype, "ensureAddon").mockReturnValue(addon);
	const { registerIpcHandlers } = await import("./handlers");
	const { ipcMain, invoke } = fakeIpcMain();
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
		{ restoreInterruptedRecording: false, enableCleanVoiceJobs: false, ipcMain },
	);
	return { recovery, invoke };
}

const event = { sender: { isDestroyed: () => false, send: vi.fn() } };
const spec = {
	width: 320,
	height: 240,
	fps: 30,
	durationS: 2,
	codec: "h264" as const,
	expectedBytes: 3,
};
const clips: ExportSourceMetadata["clips"] = [
	{
		screenPath: "/media/screen.mp4",
		webcamPath: "/media/camera.mov",
		sourceStartSec: 0,
		sourceEndSec: 2,
		webcamOffsetSec: 0,
		hasAudio: false,
	},
];

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const originalVitePublic = process.env.VITE_PUBLIC;

describe("write-export-to-path source protection", () => {
	beforeEach(async () => {
		vi.resetModules();
		paths.userData = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-export-ipc-user-"));
		paths.temp = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-export-ipc-temp-"));
		process.env.VITE_PUBLIC = path.join(paths.userData, "empty-public");
		Object.defineProperty(process, "resourcesPath", { value: paths.temp, configurable: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalResourcesPath) {
			Object.defineProperty(process, "resourcesPath", originalResourcesPath);
		} else {
			Reflect.deleteProperty(process, "resourcesPath");
		}
		if (originalVitePublic === undefined) Reflect.deleteProperty(process.env, "VITE_PUBLIC");
		else process.env.VITE_PUBLIC = originalVitePublic;
		await fs.rm(paths.userData, { recursive: true, force: true });
		await fs.rm(paths.temp, { recursive: true, force: true });
	});

	it("rejects omitted source metadata before publication", async () => {
		const addon = {
			verifyVideoExport: vi.fn(),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const { recovery, invoke } = await register(addon);
		await recovery;

		const result = (await invoke(
			"write-export-to-path",
			event,
			new Uint8Array([1, 2, 3]).buffer,
			path.join(paths.userData, "output.mp4"),
			spec,
			"export-id",
		)) as WriteResult;

		expect(result).toMatchObject({ success: false, message: "Invalid export source contract" });
		expect(addon.verifyVideoExport).not.toHaveBeenCalled();
	});

	it("accepts the empty camera sentinel produced by camera-less CLI exports", async () => {
		const addon = {
			verifyVideoExport: vi.fn(async () => {
				throw new Error("verification reached");
			}),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const { recovery, invoke } = await register(addon);
		await recovery;
		const sourceMetadata: ExportSourceMetadata = {
			clips: [{ ...clips[0]!, webcamPath: "" }],
		};

		const result = (await invoke(
			"write-export-to-path",
			event,
			new Uint8Array([1, 2, 3]).buffer,
			path.join(paths.userData, "output.mp4"),
			spec,
			"export-id",
			sourceMetadata,
		)) as WriteResult;

		expect(result.message).not.toBe("Invalid export source contract");
		expect(result.error).toContain("verification reached");
		expect(addon.verifyVideoExport).toHaveBeenCalledOnce();
	});

	it.skipIf(process.platform === "win32")(
		"resolves bundled wallpaper and cursor sources in main before rejecting publication",
		async () => {
			const wallpaper = path.join(paths.temp, "wallpapers", "wallpaper1.jpg");
			const cursor = path.join(paths.temp, DEFAULT_CURSOR_SPRITES.arrow.assetPath);
			await fs.mkdir(path.dirname(wallpaper), { recursive: true });
			await fs.mkdir(path.dirname(cursor), { recursive: true });
			await fs.writeFile(wallpaper, "original wallpaper");
			await fs.writeFile(cursor, "original cursor");
			const addon = {
				verifyVideoExport: vi.fn(),
				cancelExport: vi.fn(() => true),
			} as unknown as CompositorViewAddon;
			const { recovery, invoke } = await register(addon);
			await recovery;
			const sceneJson = JSON.stringify({
				background: { kind: "image", path: "/wallpapers/wallpaper1.jpg" },
				cursor: { theme: "default" },
			});
			const sourceMetadata: ExportSourceMetadata = { clips, sceneJson };

			for (const source of [wallpaper, cursor]) {
				const target = path.join(paths.userData, "output.mp4");
				await fs.symlink(source, target);
				const result = (await invoke(
					"write-export-to-path",
					event,
					new Uint8Array([1, 2, 3]).buffer,
					target,
					spec,
					"export-id",
					sourceMetadata,
				)) as WriteResult;
				expect(result.success).toBe(false);
				expect(result.error).toContain("one of the sources in this export");
				await fs.rm(target);
			}
			expect(addon.verifyVideoExport).not.toHaveBeenCalled();
			expect(await fs.readFile(wallpaper, "utf8")).toBe("original wallpaper");
			expect(await fs.readFile(cursor, "utf8")).toBe("original cursor");
		},
	);

	it("rejects publication over standalone microphone or system-audio originals", async () => {
		const original = path.join(paths.userData, "standalone-original.mp4");
		await fs.writeFile(original, "original standalone audio");
		const addon = {
			verifyVideoExport: vi.fn(),
			cancelExport: vi.fn(() => true),
		} as unknown as CompositorViewAddon;
		const { recovery, invoke } = await register(addon);
		await recovery;

		for (const key of ["microphoneAudioPath", "systemAudioPath"] as const) {
			const sourceMetadata: ExportSourceMetadata = {
				clips: [{ ...clips[0]!, [key]: original }],
			};
			const result = (await invoke(
				"write-export-to-path",
				event,
				new Uint8Array([1, 2, 3]).buffer,
				original,
				spec,
				"export-id",
				sourceMetadata,
			)) as WriteResult;
			expect(result.success).toBe(false);
			expect(result.error).toContain("one of the sources in this export");
			expect(await fs.readFile(original, "utf8")).toBe("original standalone audio");
		}
		expect(addon.verifyVideoExport).not.toHaveBeenCalled();
	});
});

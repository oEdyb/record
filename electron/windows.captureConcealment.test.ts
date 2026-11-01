import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;

const fixture = vi.hoisted(() => {
	function makeWindow() {
		const listeners = new Map<string, () => void>();
		const state = { visible: false };
		return {
			listeners,
			state,
			webContents: { id: 1, on: vi.fn(), send: vi.fn() },
			on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
			once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
			isDestroyed: () => false,
			isVisible: () => state.visible,
			setContentProtection: vi.fn(),
			setAutoHideMenuBar: vi.fn(),
			setVisibleOnAllWorkspaces: vi.fn(),
			setAlwaysOnTop: vi.fn(),
			loadURL: vi.fn(),
			show: vi.fn(() => {
				state.visible = true;
			}),
			showInactive: vi.fn(() => {
				state.visible = true;
			}),
			hide: vi.fn(() => {
				state.visible = false;
			}),
		};
	}
	const created: ReturnType<typeof makeWindow>[] = [];
	const BrowserWindow = vi.fn(function () {
		const win = makeWindow();
		created.push(win);
		return win;
	});
	return { created, BrowserWindow };
});

vi.mock("./niriCameraPreviewGuard", () => ({
	NiriCameraPreviewGuard: class {
		begin = vi.fn().mockResolvedValue(false);
		end = vi.fn();
		invalidate = vi.fn();
	},
}));

vi.mock("electron", () => ({
	BrowserWindow: fixture.BrowserWindow,
	ipcMain: {},
	MessageChannelMain: vi.fn(),
	screen: {
		getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
		on: vi.fn(),
	},
}));

vi.mock("./ipc/trustedRendererIpc", () => ({
	createTrustedRendererIpcMain: () => ({ on: vi.fn() }),
}));

async function load(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform });
	// Electron's process extension, read when windows.ts loads on macOS.
	Object.defineProperty(process, "getSystemVersion", {
		value: () => "15.0.0",
		configurable: true,
	});
	vi.resetModules();
	vi.clearAllMocks();
	fixture.created.length = 0;
	return import("./windows");
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	Reflect.deleteProperty(process, "getSystemVersion");
});

describe("Notes and Transcript during a Linux take", () => {
	beforeEach(() => {
		vi.stubEnv("HEADLESS", "true");
	});

	it.each([
		["Notes", "createNotesWindow"],
		["Transcript", "createTranscriptWindow"],
	] as const)("%s unmaps when the recorder conceals its controls and returns on Pause", async (_label, factory) => {
		const windows = await load("linux");
		windows[factory]();
		const win = fixture.created[0];
		win.listeners.get("ready-to-show")?.();
		expect(win.show).toHaveBeenCalledTimes(1);

		await windows.setCameraPreviewCaptureHidden(true);
		expect(win.hide).toHaveBeenCalledTimes(1);

		await windows.setCameraPreviewCaptureHidden(false);
		expect(win.showInactive).toHaveBeenCalledTimes(1);
		expect(win.state.visible).toBe(true);
	});

	it("keeps a window that finishes loading mid-take hidden until Pause", async () => {
		const windows = await load("linux");
		await windows.setCameraPreviewCaptureHidden(true);
		windows.createNotesWindow();
		const win = fixture.created[0];
		win.listeners.get("ready-to-show")?.();
		expect(win.show).not.toHaveBeenCalled();

		await windows.setCameraPreviewCaptureHidden(false);
		expect(win.showInactive).toHaveBeenCalledTimes(1);
	});

	it("forgets a closed window", async () => {
		const windows = await load("linux");
		windows.createNotesWindow();
		const win = fixture.created[0];
		win.listeners.get("ready-to-show")?.();
		win.listeners.get("closed")?.();
		await windows.setCameraPreviewCaptureHidden(true);
		expect(win.hide).not.toHaveBeenCalled();
	});

	it.each([
		"darwin",
		"win32",
	] as const)("leaves Notes alone on %s, where content protection excludes it", async (platform) => {
		const windows = await load(platform);
		windows.createNotesWindow();
		const win = fixture.created[0];
		win.listeners.get("ready-to-show")?.();
		await windows.setCameraPreviewCaptureHidden(true);
		expect(win.hide).not.toHaveBeenCalled();
		expect(win.setContentProtection).toHaveBeenCalledWith(true);
	});
});

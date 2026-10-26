import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;

const fixture = vi.hoisted(() => {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const dimensions = { width: 472, height: 112 };
	const win = {
		webContents: { id: 1, on: vi.fn(), send: vi.fn() },
		on: vi.fn(),
		once: vi.fn(),
		isDestroyed: () => false,
		isVisible: () => true,
		isMinimized: () => false,
		setContentProtection: vi.fn(),
		setIgnoreMouseEvents: vi.fn(),
		loadURL: vi.fn(),
		getSize: (): [number, number] => [dimensions.width, dimensions.height],
		setSize: vi.fn((width: number, height: number) => {
			dimensions.width = width;
			dimensions.height = height;
		}),
		setBounds: vi.fn(),
	};
	const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
	const BrowserWindow = vi.fn(function () {
		return win;
	});
	return { handlers, dimensions, win, BrowserWindow, workArea };
});

vi.mock("electron", () => ({
	BrowserWindow: fixture.BrowserWindow,
	ipcMain: {},
	MessageChannelMain: vi.fn(),
	screen: {
		getPrimaryDisplay: () => ({ workArea: fixture.workArea }),
		on: vi.fn(),
	},
}));

vi.mock("./ipc/trustedRendererIpc", () => ({
	createTrustedRendererIpcMain: () => ({
		on: (channel: string, listener: (...args: unknown[]) => void) =>
			fixture.handlers.set(channel, listener),
	}),
}));

beforeEach(async () => {
	Object.defineProperty(process, "platform", { value: "linux" });
	vi.resetModules();
	vi.clearAllMocks();
	fixture.handlers.clear();
	fixture.dimensions.width = 472;
	fixture.dimensions.height = 112;
	vi.stubEnv("HEADLESS", "true");
	const { createHudOverlayWindow } = await import("./windows");
	createHudOverlayWindow();
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	vi.unstubAllEnvs();
});

function send(channel: string, ...args: unknown[]) {
	const handler = fixture.handlers.get(channel);
	if (!handler) throw new Error(`Missing HUD handler: ${channel}`);
	handler({ sender: { id: 1 } }, ...args);
}

describe("Linux native HUD input", () => {
	it("creates a compact real window and ignores the shared transparent reserve", () => {
		expect(fixture.BrowserWindow).toHaveBeenCalledWith(
			expect.objectContaining({ width: 472, height: 112 }),
		);
		send("hud-overlay-set-size", 940, 1400);
		send("hud-overlay-set-pill-size", 424, 50, 0, 0);
		expect(fixture.win.setSize).not.toHaveBeenCalled();
		expect(fixture.win.setBounds).not.toHaveBeenCalled();
	});

	it("cannot become unrecoverably click-through even if the renderer asks", () => {
		send("hud-overlay-ignore-mouse-events", true);
		send("hud-overlay-ignore-mouse-events", false);
		send("hud-overlay-ignore-mouse-events", true);
		expect(fixture.win.setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("resizes for a panel and shrinks after dismissal without setting global bounds", () => {
		const bar = { x: 24, y: 38, width: 424, height: 50 };
		send("hud-overlay-set-direction-exclusion-rects", [
			bar,
			{ x: 24, y: 96, width: 652, height: 400 },
		]);
		expect(fixture.win.setSize).toHaveBeenLastCalledWith(700, 520);
		send("hud-overlay-set-direction-exclusion-rects", [bar]);
		expect(fixture.win.setSize).toHaveBeenLastCalledWith(472, 112);
		expect(fixture.win.setBounds).not.toHaveBeenCalled();
	});
});

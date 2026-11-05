import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;

const fixture = vi.hoisted(() => {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const dimensions = { width: 472, height: 112 };
	const previewGuard = {
		begin: vi.fn().mockResolvedValue(false),
		end: vi.fn(),
		invalidate: vi.fn(),
	};
	let onUnsafe: () => void = () => undefined;
	const win = {
		webContents: { id: 1, on: vi.fn(), send: vi.fn() },
		on: vi.fn(),
		once: vi.fn(),
		isDestroyed: () => false,
		isVisible: () => true,
		isMinimized: () => false,
		isMaximized: vi.fn(() => false),
		isFullScreen: vi.fn(() => false),
		unmaximize: vi.fn(),
		getNormalBounds: () => ({ x: 100, y: 80, width: 312, height: 186 }),
		setContentProtection: vi.fn(),
		showInactive: vi.fn(),
		hide: vi.fn(),
		minimize: vi.fn(),
		setIgnoreMouseEvents: vi.fn(),
		loadURL: vi.fn(),
		getSize: (): [number, number] => [dimensions.width, dimensions.height],
		setSize: vi.fn((width: number, height: number) => {
			dimensions.width = width;
			dimensions.height = height;
		}),
		getPosition: (): [number, number] => [100, 80],
		getBounds: () => ({ x: 100, y: 80, ...dimensions }),
		setPosition: vi.fn(),
		setBounds: vi.fn((bounds: { width: number; height: number }) => {
			dimensions.width = bounds.width;
			dimensions.height = bounds.height;
		}),
	};
	const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
	const BrowserWindow = vi.fn(function () {
		return win;
	});
	return {
		handlers,
		rememberPlacement: vi.fn(),
		dimensions,
		win,
		BrowserWindow,
		workArea,
		previewGuard,
		setUnsafe: (callback: () => void) => {
			onUnsafe = callback;
		},
		revoke: () => onUnsafe(),
	};
});

vi.mock("./niriHudFocus", () => ({ rememberNiriHudPlacement: fixture.rememberPlacement }));

vi.mock("./niriCaptureWindowGuard", () => ({
	NiriCaptureWindowGuard: class {
		constructor(_title: string, onUnsafe: () => void) {
			fixture.setUnsafe(onUnsafe);
		}
		begin = fixture.previewGuard.begin;
		end = fixture.previewGuard.end;
		invalidate = fixture.previewGuard.invalidate;
	},
}));

vi.mock("electron", () => ({
	BrowserWindow: fixture.BrowserWindow,
	ipcMain: {},
	MessageChannelMain: vi.fn(),
	screen: {
		getPrimaryDisplay: () => ({ workArea: fixture.workArea }),
		getDisplayNearestPoint: () => ({ workArea: fixture.workArea }),
		getDisplayMatching: () => ({ workArea: fixture.workArea }),
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
	fixture.rememberPlacement.mockResolvedValue(undefined);
	fixture.previewGuard.begin.mockResolvedValue(false);
	fixture.win.isMaximized.mockReturnValue(false);
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
	it.each(["linux", "darwin", "win32"])("uses the platform hide behavior on %s", (platform) => {
		Object.defineProperty(process, "platform", { value: platform });
		send("hud-overlay-hide");
		expect(fixture.win.hide).toHaveBeenCalledTimes(platform === "linux" ? 1 : 0);
		expect(fixture.win.minimize).toHaveBeenCalledTimes(platform === "linux" ? 0 : 1);
	});

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

	it("resizes fixed bounds for a panel and shrinks after dismissal", () => {
		const bar = { x: 24, y: 38, width: 424, height: 50 };
		send("hud-overlay-set-direction-exclusion-rects", [
			bar,
			{ x: 24, y: 96, width: 652, height: 400 },
		]);
		expect(fixture.win.setBounds).toHaveBeenLastCalledWith(
			{ x: 100, y: 80, width: 700, height: 520 },
			false,
		);
		send("hud-overlay-set-direction-exclusion-rects", [bar]);
		expect(fixture.win.setBounds).toHaveBeenLastCalledWith(
			{ x: 100, y: 80, width: 472, height: 112 },
			false,
		);
		expect(fixture.win.setPosition).not.toHaveBeenCalled();
	});
});

describe("Linux camera preview capture privacy", () => {
	it("suppresses late visibility requests and creation until capture releases it", async () => {
		const { createCameraPreviewWindow, setCameraPreviewCaptureHidden } = await import("./windows");
		await setCameraPreviewCaptureHidden(true);
		createCameraPreviewWindow();
		expect(fixture.BrowserWindow).toHaveBeenLastCalledWith(
			expect.objectContaining({ title: "Klippt Camera" }),
		);
		const titleUpdate = fixture.win.on.mock.calls.find(
			([event]) => event === "page-title-updated",
		)?.[1];
		if (!titleUpdate) throw new Error("Camera title guard missing");
		const preventDefault = vi.fn();
		titleUpdate({ preventDefault });
		expect(preventDefault).toHaveBeenCalledOnce();
		const ready = [...fixture.win.once.mock.calls]
			.reverse()
			.find(([event]) => event === "ready-to-show")?.[1];
		if (!ready) throw new Error("Camera preview ready callback missing");
		ready();
		send("camera-preview-set-visible", true);
		expect(fixture.win.showInactive).not.toHaveBeenCalled();
		await setCameraPreviewCaptureHidden(false);
		expect(fixture.win.showInactive).toHaveBeenCalledOnce();
		await setCameraPreviewCaptureHidden(true);
		send("camera-preview-set-visible", false);
		await setCameraPreviewCaptureHidden(false);
		expect(fixture.win.showInactive).toHaveBeenCalledOnce();
	});
});

it("keeps a proven second-monitor preview mapped until admission is revoked", async () => {
	const { createCameraPreviewWindow, setCameraPreviewCaptureHidden } = await import("./windows");
	createCameraPreviewWindow();
	const ready = [...fixture.win.once.mock.calls]
		.reverse()
		.find(([event]) => event === "ready-to-show")?.[1];
	if (!ready) throw new Error("Camera preview readiness missing");
	ready();
	send("camera-preview-set-visible", true);
	fixture.win.hide.mockClear();
	fixture.previewGuard.begin.mockResolvedValueOnce(true);
	await setCameraPreviewCaptureHidden(true, 91);
	expect(fixture.previewGuard.begin).toHaveBeenLastCalledWith(91);
	expect(fixture.win.hide).not.toHaveBeenCalled();
	fixture.revoke();
	expect(fixture.win.hide).toHaveBeenCalledOnce();
	await setCameraPreviewCaptureHidden(false);
	expect(fixture.win.showInactive).toHaveBeenCalledTimes(2);
});

it("restores the fixed camera window with atomic bounds after expansion", async () => {
	const { createCameraPreviewWindow } = await import("./windows");
	createCameraPreviewWindow();
	send("camera-preview-set-expanded", true);
	expect(fixture.dimensions.width).toBeGreaterThan(312);
	fixture.win.setBounds.mockClear();
	send("camera-preview-set-expanded", false);
	expect(fixture.win.setBounds).toHaveBeenCalledWith(
		{ x: 100, y: 80, width: 312, height: 186 },
		false,
	);
	expect(fixture.win.setPosition).toHaveBeenLastCalledWith(100, 80, false);
});

it("restores the requested recording bar size after native maximize", () => {
	fixture.win.isMaximized.mockReturnValue(true);
	send("hud-overlay-set-direction-exclusion-rects", [{ x: 24, y: 38, width: 424, height: 50 }]);
	expect(fixture.win.setSize).not.toHaveBeenCalled();
	fixture.win.isMaximized.mockReturnValue(false);
	const restore = fixture.win.on.mock.calls.find(([event]) => event === "unmaximize")?.[1];
	expect(restore).toBeTypeOf("function");
	restore?.();
	expect(fixture.win.setBounds).toHaveBeenCalledWith(
		{ x: 100, y: 80, width: 472, height: 112 },
		false,
	);
});

it("restores new popup bounds measured during maximize or fullscreen", () => {
	for (const event of ["unmaximize", "leave-full-screen"]) {
		fixture.win.isMaximized.mockReturnValue(true);
		send("hud-overlay-set-direction-exclusion-rects", [{ x: 24, y: 96, width: 652, height: 400 }]);
		fixture.win.isMaximized.mockReturnValue(false);
		fixture.win.on.mock.calls.find(([name]) => name === event)?.[1]();
		expect(fixture.win.setBounds).toHaveBeenLastCalledWith(
			{ x: 100, y: 80, width: 700, height: 520 },
			false,
		);
	}
});

it("keeps the original niri placement through re-expansion during restore", async () => {
	vi.stubEnv("NIRI_SOCKET", "private-test-socket");
	let finish: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let count = 0;
	const restore = vi.fn(async () => {
		if (++count === 1) await pending;
	});
	fixture.rememberPlacement.mockResolvedValue(restore);
	const { createCameraPreviewWindow } = await import("./windows");
	createCameraPreviewWindow();
	send("camera-preview-set-expanded", true);
	await Promise.resolve();
	await Promise.resolve();
	send("camera-preview-set-expanded", false);
	send("camera-preview-set-expanded", true);
	await Promise.resolve();
	await Promise.resolve();
	expect(fixture.rememberPlacement).toHaveBeenCalledTimes(1);
	finish();
	await Promise.resolve();
	await Promise.resolve();
	send("camera-preview-set-expanded", false);
	await Promise.resolve();
	await Promise.resolve();
	expect(restore).toHaveBeenCalledTimes(2);
});

it("collapses a compositor-maximized camera with its own control", async () => {
	const { createCameraPreviewWindow } = await import("./windows");
	createCameraPreviewWindow();
	fixture.win.isMaximized.mockReturnValue(true);
	const maximize = fixture.win.on.mock.calls
		.filter(([event]) => event === "maximize")
		.slice(-1)[0]?.[1];
	expect(maximize).toBeTypeOf("function");
	maximize?.();
	expect(fixture.win.webContents.send).toHaveBeenCalledWith(
		"camera-preview-expanded-changed",
		true,
	);
	send("camera-preview-set-expanded", false);
	expect(fixture.win.unmaximize).toHaveBeenCalledOnce();
	expect(fixture.win.setBounds).toHaveBeenLastCalledWith(
		{ x: 100, y: 80, width: 312, height: 186 },
		false,
	);
});

it("remembers fresh niri placement after a completed restore fails", async () => {
	vi.stubEnv("NIRI_SOCKET", "private-test-socket");
	fixture.rememberPlacement
		.mockResolvedValueOnce(vi.fn().mockRejectedValue(new Error("Private restore failed")))
		.mockResolvedValue(undefined);
	const { createCameraPreviewWindow } = await import("./windows");
	createCameraPreviewWindow();
	send("camera-preview-set-expanded", true);
	await Promise.resolve();
	await Promise.resolve();
	send("camera-preview-set-expanded", false);
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	send("camera-preview-set-expanded", true);
	await Promise.resolve();
	await Promise.resolve();
	expect(fixture.rememberPlacement).toHaveBeenCalledTimes(2);
});

import { describe, expect, it, vi } from "vitest";
import { LinuxRecordingHud } from "./linuxRecordingHud";

function setup(platform = "linux", sourceKind = "monitor") {
	let capturing = false;
	const order: string[] = [];
	const window = {
		isDestroyed: () => false,
		hide: vi.fn(() => order.push("hide")),
		show: vi.fn(() => order.push("show")),
		focus: vi.fn(),
		webContents: { send: vi.fn() },
	};
	const hud = new LinuxRecordingHud(
		platform,
		() => window,
		() => capturing,
		() => sourceKind !== "window",
		async () => {
			order.push("unmap");
		},
	);
	return {
		hud,
		window,
		order,
		setCapturing: (value: boolean) => {
			capturing = value;
		},
	};
}

describe("Linux recording controls", () => {
	it("unmaps before capture and stays hidden until the writer pauses", async () => {
		const { hud, window, order, setCapturing } = setup();
		await hud.capture(async () => {
			order.push("record");
			setCapturing(true);
			return { success: true };
		});
		expect(order).toEqual(["hide", "unmap", "record"]);
		expect(hud.requestControls()).toBe(true);
		expect(hud.requestControls()).toBe(true);
		expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("hud-toggle-recording-pause");
		hud.pauseCompleted();
		expect(window.show).not.toHaveBeenCalled();
		setCapturing(false);
		hud.pauseCompleted();
		expect(window.show).toHaveBeenCalledOnce();
	});

	it("restores controls after failed start or rejected Continue", async () => {
		const { hud, window } = setup();
		await hud.capture(async () => ({ success: false }));
		expect(window.show).toHaveBeenCalledOnce();
		await expect(
			hud.capture(async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		expect(window.show).toHaveBeenCalledTimes(2);
	});

	it("cannot start a take after Stop cancels the unmap wait", async () => {
		const { hud } = setup();
		const record = vi.fn(async () => ({ success: true }));
		const pending = hud.capture(record);
		hud.cancelPending();
		await expect(pending).rejects.toThrow("cancelled");
		expect(record).not.toHaveBeenCalled();
	});

	it("keeps controls available when only another window is recorded", async () => {
		const { hud, window, setCapturing } = setup("linux", "window");
		await hud.capture(async () => {
			setCapturing(true);
			return { success: true };
		});
		expect(window.hide).not.toHaveBeenCalled();
		expect(hud.requestControls()).toBe(false);
	});

	it("a cancelled start cannot reveal controls during its replacement", async () => {
		const window = {
			isDestroyed: () => false,
			hide: vi.fn(),
			show: vi.fn(),
			focus: vi.fn(),
			webContents: { send: vi.fn() },
		};
		const waits: Array<() => void> = [];
		let capturing = false;
		const hud = new LinuxRecordingHud(
			"linux",
			() => window,
			() => capturing,
			() => true,
			() => new Promise<void>((resolve) => waits.push(resolve)),
		);
		const oldStart = hud.capture(async () => ({ success: true }));
		hud.cancelPending();
		const newStart = hud.capture(async () => {
			capturing = true;
			return { success: true };
		});
		waits[0]();
		await expect(oldStart).rejects.toThrow("cancelled");
		expect(window.show).not.toHaveBeenCalled();
		waits[1]();
		await newStart;
		expect(window.show).not.toHaveBeenCalled();
		expect(hud.requestControls()).toBe(true);
		expect(window.webContents.send).toHaveBeenCalledOnce();
	});

	it("an old Stop completion cannot reveal a new capture transition", async () => {
		const window = {
			isDestroyed: () => false,
			hide: vi.fn(),
			show: vi.fn(),
			focus: vi.fn(),
			webContents: { send: vi.fn() },
		};
		let finishWait: (() => void) | undefined;
		let capturing = false;
		const hud = new LinuxRecordingHud(
			"linux",
			() => window,
			() => capturing,
			() => true,
			() =>
				new Promise<void>((resolve) => {
					finishWait = resolve;
				}),
		);
		const start = hud.capture(async () => {
			capturing = true;
			return { success: true };
		});
		hud.pauseCompleted();
		expect(window.show).not.toHaveBeenCalled();
		finishWait?.();
		await start;
		expect(window.show).not.toHaveBeenCalled();
		expect(hud.requestControls()).toBe(true);
		expect(window.webContents.send).toHaveBeenCalledOnce();
	});

	it.each(["darwin", "win32"])("leaves %s untouched", async (platform) => {
		const { hud, window } = setup(platform);
		await hud.capture(async () => ({ success: true }));
		hud.pauseCompleted();
		expect(hud.requestControls()).toBe(false);
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.show).not.toHaveBeenCalled();
	});
});

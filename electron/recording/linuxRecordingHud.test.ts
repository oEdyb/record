import { describe, expect, it, vi } from "vitest";
import { LinuxRecordingHud } from "./linuxRecordingHud";
import { withHiddenPortalHud } from "./portalSelectionHud";

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function setup(platform = "linux", sourceKind = "monitor", shouldShowControls = () => true) {
	let capturing = false;
	const order: string[] = [];
	const window = {
		isDestroyed: () => false,
		hide: vi.fn(() => order.push("hide")),
		show: vi.fn(() => order.push("show")),
		focus: vi.fn(),
		webContents: { send: vi.fn() },
	};
	const previewHidden = vi.fn();
	const hud = new LinuxRecordingHud(
		platform,
		() => window,
		() => capturing,
		() => sourceKind !== "window",
		async () => {
			order.push("unmap");
		},
		undefined,
		previewHidden,
		undefined,
		shouldShowControls,
	);
	return {
		hud,
		previewHidden,
		window,
		order,
		setCapturing: (value: boolean) => {
			capturing = value;
		},
	};
}

describe("Linux recording controls", () => {
	it("keeps the pill hidden after a Linux source choice or failure while Studio owns controls", () => {
		let studio = true;
		const { hud, window, previewHidden } = setup("linux", "monitor", () => !studio);
		hud.pauseCompleted();
		expect(window.show).not.toHaveBeenCalled();
		expect(window.focus).not.toHaveBeenCalled();
		expect(previewHidden).toHaveBeenCalledWith(false);
		studio = false;
		hud.pauseCompleted();
		expect(window.show).toHaveBeenCalledOnce();
	});

	it("keeps a proven second-monitor pill mapped and hides when its position becomes unsafe", async () => {
		const { window } = setup();
		const isolation = { begin: vi.fn().mockResolvedValue(true), end: vi.fn() };
		let capturing = false;
		const hud = new LinuxRecordingHud(
			"linux",
			() => window,
			() => capturing,
			() => true,
			async () => undefined,
			undefined,
			undefined,
			isolation,
		);
		await hud.capture(async () => {
			capturing = true;
			return { success: true };
		});
		expect(window.hide).not.toHaveBeenCalled();
		expect(hud.requestControls()).toBe(false);
		hud.conceal();
		expect(window.hide).toHaveBeenCalledOnce();
		expect(hud.requestControls()).toBe(true);
		capturing = false;
		hud.pauseCompleted();
		expect(isolation.end).toHaveBeenCalled();
	});

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
		expect(window.webContents.send).not.toHaveBeenCalled();
		hud.pauseCompleted();
		expect(window.show).not.toHaveBeenCalled();
		setCapturing(false);
		hud.pauseCompleted();
		expect(window.show).toHaveBeenCalledOnce();
	});

	it("conceals live camera preview until capture is confirmed paused", async () => {
		const { hud, previewHidden, setCapturing } = setup();
		await hud.capture(async () => {
			expect(previewHidden).toHaveBeenLastCalledWith(true);
			setCapturing(true);
			return { success: true };
		});
		hud.pauseCompleted();
		expect(previewHidden).toHaveBeenCalledExactlyOnceWith(true);
		setCapturing(false);
		hud.pauseCompleted();
		expect(previewHidden).toHaveBeenLastCalledWith(false);
	});

	it("waits for the preview location decision before admitting the writer", async () => {
		const window = {
			isDestroyed: () => false,
			hide: vi.fn(),
			show: vi.fn(),
			focus: vi.fn(),
			webContents: { send: vi.fn() },
		};
		let finish: (() => void) | undefined;
		const decide = () =>
			new Promise<void>((resolve) => {
				finish = resolve;
			});
		const record = vi.fn(async () => ({ success: true }));
		const hud = new LinuxRecordingHud(
			"linux",
			() => window,
			() => false,
			() => true,
			async () => undefined,
			undefined,
			decide,
		);
		const start = hud.capture(record);
		expect(record).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(finish).toBeDefined());
		finish?.();
		await start;
		expect(record).toHaveBeenCalledOnce();
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
		await vi.waitFor(() => expect(waits).toHaveLength(1));
		hud.cancelPending();
		const newStart = hud.capture(async () => {
			capturing = true;
			return { success: true };
		});
		await vi.waitFor(() => expect(waits).toHaveLength(2));
		waits[0]();
		await expect(oldStart).rejects.toThrow("cancelled");
		expect(window.show).not.toHaveBeenCalled();
		waits[1]();
		await newStart;
		expect(window.show).not.toHaveBeenCalled();
		expect(hud.requestControls()).toBe(true);
		expect(window.webContents.send).not.toHaveBeenCalled();
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
		await vi.waitFor(() => expect(finishWait).toBeDefined());
		hud.pauseCompleted();
		expect(window.show).not.toHaveBeenCalled();
		finishWait?.();
		await start;
		expect(window.show).not.toHaveBeenCalled();
		expect(hud.requestControls()).toBe(true);
		expect(window.webContents.send).not.toHaveBeenCalled();
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

it("waits for an old placement RPC before proving a replacement capture safe", async () => {
	const { window } = setup();
	const portalWindow = { ...window, isVisible: () => true, showInactive: vi.fn() };
	const entered = deferred<void>();
	const finish = deferred<void>();
	const order: string[] = [];
	const picker = withHiddenPortalHud(
		() => portalWindow,
		async () => "grant",
		async () => async () => {
			entered.resolve();
			await finish.promise;
			order.push("placement-finished");
		},
	);
	const rejected = expect(picker).rejects.toThrow("Source selection cancelled");
	await entered.promise;
	let capturing = false;
	const hud = new LinuxRecordingHud(
		"linux",
		() => portalWindow,
		() => capturing,
		() => true,
		async () => undefined,
		undefined,
		undefined,
		{
			begin: async () => {
				order.push("prove");
				return true;
			},
			end: () => undefined,
		},
	);
	const capture = hud.capture(async () => {
		order.push("record");
		capturing = true;
		return { success: true };
	});
	expect(order).toEqual([]);
	const cancelledCapture = expect(capture).rejects.toThrow("Recording start cancelled");
	const replacement = hud.capture(async () => {
		order.push("record");
		capturing = true;
		return { success: true };
	});
	expect(order).toEqual([]);
	finish.resolve();
	await cancelledCapture;
	await replacement;
	await rejected;
	expect(order).toEqual(["placement-finished", "prove", "record"]);
	expect(window.hide).toHaveBeenCalledOnce();
	expect(window.show).not.toHaveBeenCalled();
});

it("conceals without transport when isolation is lost during a take", () => {
	const { hud, window, setCapturing } = setup();
	setCapturing(true);
	hud.revoke();
	expect(window.hide).toHaveBeenCalledOnce();
	expect(window.webContents.send).not.toHaveBeenCalled();
	hud.revoke();
	expect(window.webContents.send).not.toHaveBeenCalled();
	expect(window.show).not.toHaveBeenCalled();
	setCapturing(false);
	hud.pauseCompleted();
	expect(window.show).toHaveBeenCalledOnce();
});

it("does not pause when a deliberate Hide or Studio unmaps the pill", () => {
	const { hud, window, setCapturing } = setup();
	setCapturing(true);
	Object.assign(window, { isVisible: () => false });
	hud.revoke();
	expect(window.webContents.send).not.toHaveBeenCalled();
	expect(hud.requestControls()).toBe(true);
	expect(window.webContents.send).not.toHaveBeenCalled();
	hud.cancelPending();
});

it("retries visibility after transitions without changing transport", async () => {
	vi.useFakeTimers();
	try {
		const { hud, window, setCapturing } = setup();
		setCapturing(true);
		hud.revoke();
		await vi.advanceTimersByTimeAsync(500);
		expect(window.webContents.send).not.toHaveBeenCalled();
		setCapturing(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(window.show).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1000);
		expect(window.webContents.send).not.toHaveBeenCalled();
		hud.cancelPending();
	} finally {
		vi.useRealTimers();
	}
});

it("recovers a revocation that arrives before capture finishes transitioning", async () => {
	const { hud, window, setCapturing } = setup();
	await hud.capture(async () => {
		setCapturing(true);
		hud.revoke();
		expect(window.webContents.send).not.toHaveBeenCalled();
		return { success: true };
	});
	expect(window.webContents.send).not.toHaveBeenCalled();
	hud.cancelPending();
});

it("does not mark a safely captured visible pill concealed when cancelling stale prepare work", async () => {
	const { hud, setCapturing, window } = setup("linux", "window");
	await hud.capture(async () => {
		setCapturing(true);
		return { success: true };
	});
	hud.cancelPending();
	expect(hud.requestControls()).toBe(false);
	expect(window.webContents.send).not.toHaveBeenCalled();
});

it("retains revocation recovery when a late placement proof reports retained", async () => {
	const { window } = setup();
	const proof = deferred<boolean>();
	let capturing = false;
	const hud = new LinuxRecordingHud(
		"linux",
		() => window,
		() => capturing,
		() => true,
		async () => undefined,
		undefined,
		undefined,
		{ begin: () => proof.promise, end: () => undefined },
	);
	const capture = hud.capture(async () => {
		capturing = true;
		return { success: true };
	});
	await Promise.resolve();
	hud.revoke();
	expect(window.webContents.send).not.toHaveBeenCalled();
	proof.resolve(true);
	await capture;
	expect(window.webContents.send).not.toHaveBeenCalled();
	expect(window.show).not.toHaveBeenCalled();
	capturing = false;
	hud.pauseCompleted();
	expect(window.show).toHaveBeenCalledOnce();
	hud.cancelPending();
});

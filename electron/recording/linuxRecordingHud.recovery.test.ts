import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinuxHudLifecycle } from "./linuxHudLifecycle";
import { LinuxRecordingHud } from "./linuxRecordingHud";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function fixture(options: { proof?: Promise<boolean>; unmap?: Promise<void> } = {}) {
	let capturing = false;
	let visible = true;
	let studio = false;
	const order: string[] = [];
	const window = {
		isDestroyed: () => false,
		isVisible: () => visible,
		hide: vi.fn(() => {
			visible = false;
			order.push("hide");
		}),
		show: vi.fn(() => {
			visible = true;
			order.push("show");
		}),
		focus: vi.fn(),
		webContents: { send: vi.fn() },
	};
	const preview = vi.fn(async (hidden: boolean) => {
		order.push(`preview:${hidden}`);
	});
	const isolation = {
		begin: vi.fn(() => options.proof ?? Promise.resolve(false)),
		end: vi.fn(),
	};
	const hud = new LinuxRecordingHud(
		"linux",
		() => window,
		() => capturing,
		() => true,
		async () => {
			order.push("unmap");
			await options.unmap;
		},
		undefined,
		preview,
		isolation,
		() => !studio,
	);
	return {
		hud,
		window,
		isolation,
		preview,
		order,
		setCapturing(value: boolean) {
			capturing = value;
		},
		setStudio(value: boolean) {
			studio = value;
		},
		get visible() {
			return visible;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("recording HUD retry ownership and effects", () => {
	it("retries exactly at 500ms, withholds controls until capture stops", async () => {
		const f = fixture();
		f.setCapturing(true);
		f.hud.revoke();
		expect(f.window.webContents.send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(499);
		expect(f.window.webContents.send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.window.webContents.send).toHaveBeenCalledTimes(2);
		expect(f.window.show).not.toHaveBeenCalled();
		f.setCapturing(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(f.window.show).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("dismiss and cancel each retire the scheduled retry", async () => {
		for (const action of ["dismiss", "cancelPending"] as const) {
			const f = fixture();
			f.setCapturing(true);
			f.hud.revoke();
			f.hud[action]();
			await vi.advanceTimersByTimeAsync(1000);
			expect(f.window.webContents.send).toHaveBeenCalledTimes(1);
			expect(f.window.show).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it("rejects an already queued timer after dismissal without external effects", async () => {
		const setTimer = vi.spyOn(globalThis, "setTimeout");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const f = fixture();
		f.setCapturing(true);
		f.hud.revoke();
		const callback = setTimer.mock.calls[0][0] as () => void;
		f.hud.dismiss();
		callback();
		expect(f.window.webContents.send).toHaveBeenCalledTimes(1);
		expect(f.window.show).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith("[linux-hud] Illegal transition", {
			state: "concealed",
			event: "tick",
		});
	});

	it("does not pause for deliberate Hide or Studio while capture remains live", async () => {
		for (const studio of [false, true]) {
			const f = fixture();
			f.setCapturing(true);
			f.setStudio(studio);
			f.window.hide();
			f.hud.dismiss();
			f.hud.revoke();
			f.hud.pauseCompleted();
			await vi.advanceTimersByTimeAsync(1000);
			expect(f.window.webContents.send).not.toHaveBeenCalled();
			expect(f.window.show).not.toHaveBeenCalled();
		}
	});

	it("cancellation during an unmap wait does not admit the old operation", async () => {
		const unmap = deferred<void>();
		const f = fixture({ unmap: unmap.promise });
		const operation = vi.fn(async () => ({ success: true }));
		const start = f.hud.capture(operation);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.order).toEqual(["hide", "preview:true", "unmap"]);
		f.hud.cancelPending();
		unmap.resolve();
		await expect(start).rejects.toThrow("Recording start cancelled.");
		expect(operation).not.toHaveBeenCalled();
		expect(f.window.show).toHaveBeenCalledTimes(1);
	});

	it("failed placement restores controls only after preparation finishes", async () => {
		const proof = deferred<boolean>();
		const f = fixture({ proof: proof.promise });
		const operation = vi.fn(async () => ({ success: true }));
		const start = f.hud.capture(operation);
		const rejected = expect(start).rejects.toThrow("placement failure");
		proof.reject(new Error("placement failure"));
		await rejected;
		expect(operation).not.toHaveBeenCalled();
		expect(f.window.show).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores an acknowledgement while capture is authoritative and preserves retry", async () => {
		const f = fixture();
		f.setCapturing(true);
		f.hud.revoke();
		f.hud.pauseCompleted();
		expect(f.window.show).not.toHaveBeenCalled();
		expect(f.preview).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(500);
		expect(f.window.webContents.send).toHaveBeenCalledTimes(2);
		expect(f.window.show).not.toHaveBeenCalled();
	});

	it("does not show controls when Studio owns the paused session", () => {
		const f = fixture();
		f.setCapturing(true);
		f.hud.revoke();
		f.setStudio(true);
		f.hud.dismiss();
		f.setCapturing(false);
		f.hud.pauseCompleted();
		expect(f.window.show).not.toHaveBeenCalled();
		expect(f.window.focus).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains revocation through a delayed placement proof and preparation retry", async () => {
		const proof = deferred<boolean>();
		const f = fixture({ proof: proof.promise });
		const start = f.hud.capture(async () => {
			f.setCapturing(true);
			return { success: true };
		});
		f.hud.revoke();
		await vi.advanceTimersByTimeAsync(500);
		expect(f.window.webContents.send).not.toHaveBeenCalled();
		proof.resolve(true);
		await start;
		expect(f.window.webContents.send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(f.window.webContents.send).toHaveBeenCalledTimes(2);
		expect(f.window.show).not.toHaveBeenCalled();
		f.setCapturing(false);
		f.hud.pauseCompleted();
		expect(f.window.show).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains a new controls request after cancelling an already admitted capture", async () => {
		const started = deferred<void>();
		const finish = deferred<{ success: boolean }>();
		const f = fixture();
		const start = f.hud.capture(async () => {
			f.setCapturing(true);
			started.resolve();
			return finish.promise;
		});
		await started.promise;
		f.hud.cancelPending();
		const accepted = f.hud.requestControls();
		finish.resolve({ success: true });
		await start;
		const pausesAfterFinish = f.window.webContents.send.mock.calls.length;
		await vi.advanceTimersByTimeAsync(500);
		console.log("cancelled admitted capture", {
			accepted,
			pausesAfterFinish,
			pausesAt500ms: f.window.webContents.send.mock.calls.length,
			shows: f.window.show.mock.calls.length,
			retries: vi.getTimerCount(),
		});
		expect({
			accepted,
			pausesAfterFinish,
			pausesAt500ms: f.window.webContents.send.mock.calls.length,
			shows: f.window.show.mock.calls.length,
		}).toEqual({ accepted: true, pausesAfterFinish: 1, pausesAt500ms: 2, shows: 0 });
	});

	it("rejects stale proof and timer events after replacement", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const lifecycle = new LinuxHudLifecycle();
		const old = Symbol("old");
		const replacement = Symbol("replacement");
		const timer = setTimeout(() => undefined, 500);
		lifecycle.transition({ type: "prepare", owner: old, hide: true });
		lifecycle.transition({ type: "recover" });
		lifecycle.transition({ type: "schedule", timer });
		lifecycle.transition({ type: "prepare", owner: replacement, hide: true });
		expect(lifecycle.transition({ type: "tick", timer })).toBe(false);
		expect(lifecycle.transition({ type: "proof", owner: old, retained: true })).toBe(false);
		expect(lifecycle.transition({ type: "admit", owner: replacement })).toBe(true);
		expect(warning).toHaveBeenCalledTimes(2);
	});
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createQuitCaptureGuard } from "./quitCaptureGuard";

function setup(running = true) {
	let finishStop: () => void = () => undefined;
	const deps = {
		isCaptureRunning: vi.fn(() => running),
		stopCapture: vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishStop = resolve;
				}),
		),
		quit: vi.fn(),
	};
	return { deps, guard: createQuitCaptureGuard(deps), finishStop: () => finishStop() };
}

describe("createQuitCaptureGuard", () => {
	it("lets an idle app quit at once", () => {
		const { deps, guard } = setup(false);
		const event = { preventDefault: vi.fn() };
		guard.beforeQuit(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(deps.stopCapture).not.toHaveBeenCalled();
	});

	it("holds the quit until the take stops, then quits once", async () => {
		const { deps, guard, finishStop } = setup();
		const event = { preventDefault: vi.fn() };
		guard.beforeQuit(event);
		const repeated = { preventDefault: vi.fn() };
		guard.beforeQuit(repeated);
		expect(repeated.preventDefault).toHaveBeenCalledOnce();
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(deps.stopCapture).toHaveBeenCalledOnce();
		expect(deps.quit).not.toHaveBeenCalled();
		finishStop();
		await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledOnce());
	});

	it("stops a new take again after a quit was cancelled", async () => {
		const { deps, guard, finishStop } = setup();
		guard.beforeQuit({ preventDefault: vi.fn() });
		finishStop();
		await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledOnce());
		const next = { preventDefault: vi.fn() };
		guard.beforeQuit(next);
		expect(next.preventDefault).toHaveBeenCalledOnce();
		expect(deps.stopCapture).toHaveBeenCalledTimes(2);
	});

	it("keeps the HUD renderer alive on WM close until save completion, then allows the completing quit close", async () => {
		const { deps, guard, finishStop } = setup();
		const window = new EventEmitter();
		guard.protectWindow(window);
		const initialClose = { preventDefault: vi.fn() };
		window.emit("close", initialClose);
		expect(initialClose.preventDefault).toHaveBeenCalledOnce();
		expect(deps.quit).not.toHaveBeenCalled();
		deps.isCaptureRunning.mockReturnValue(false);
		const repeatedClose = { preventDefault: vi.fn() };
		window.emit("close", repeatedClose);
		expect(repeatedClose.preventDefault).toHaveBeenCalledOnce();
		deps.quit.mockImplementation(() => {
			const appQuit = { preventDefault: vi.fn() };
			guard.beforeQuit(appQuit);
			expect(appQuit.preventDefault).not.toHaveBeenCalled();
			const completingClose = { preventDefault: vi.fn() };
			window.emit("close", completingClose);
			expect(completingClose.preventDefault).not.toHaveBeenCalled();
		});
		finishStop();
		await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledOnce());
		expect(deps.stopCapture).toHaveBeenCalledOnce();
	});

	it("leaves idle WM close unchanged", () => {
		const { deps, guard } = setup(false);
		const window = new EventEmitter();
		guard.protectWindow(window);
		const close = { preventDefault: vi.fn() };
		window.emit("close", close);
		expect(close.preventDefault).not.toHaveBeenCalled();
		expect(deps.stopCapture).not.toHaveBeenCalled();
	});

	it("allows the final WM close after a bounded Stop timeout without recursive quitting", async () => {
		vi.useFakeTimers();
		try {
			const { deps, guard } = setup();
			const window = new EventEmitter();
			guard.protectWindow(window);
			deps.stopCapture.mockImplementation(
				() => new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
			);
			deps.quit.mockImplementation(() => {
				const close = { preventDefault: vi.fn() };
				window.emit("close", close);
				expect(close.preventDefault).not.toHaveBeenCalled();
			});
			window.emit("close", { preventDefault: vi.fn() });
			await vi.advanceTimersByTimeAsync(15_000);
			expect(deps.quit).toHaveBeenCalledOnce();
			expect(deps.stopCapture).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("never holds a WM close during logout", () => {
		const { deps, guard } = setup();
		const window = new EventEmitter();
		guard.protectWindow(window);
		guard.systemPoweringOff();
		const close = { preventDefault: vi.fn() };
		window.emit("close", close);
		expect(close.preventDefault).not.toHaveBeenCalled();
		expect(deps.stopCapture).not.toHaveBeenCalled();
	});

	it("never holds a quit while the system logs out or shuts down", () => {
		const { deps, guard } = setup();
		guard.systemPoweringOff();
		const event = { preventDefault: vi.fn() };
		guard.beforeQuit(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(deps.stopCapture).not.toHaveBeenCalled();
	});
});

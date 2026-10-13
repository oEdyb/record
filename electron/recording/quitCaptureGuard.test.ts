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
		guard.beforeQuit({ preventDefault: vi.fn() });
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

	it("never holds a quit while the system logs out or shuts down", () => {
		const { deps, guard } = setup();
		guard.systemPoweringOff();
		const event = { preventDefault: vi.fn() };
		guard.beforeQuit(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(deps.stopCapture).not.toHaveBeenCalled();
	});
});

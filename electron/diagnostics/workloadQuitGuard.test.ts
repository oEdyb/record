import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkloadQuitGuard } from "./workloadQuitGuard";

afterEach(() => vi.useRealTimers());

describe("workload quit guard", () => {
	it("holds repeated quits until reports finish, then permits the completing quit", async () => {
		let finish: () => void = () => undefined;
		const finishPreviews = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const quit = vi.fn();
		const onError = vi.fn();
		const guard = createWorkloadQuitGuard({ finishPreviews, quit, onError });
		quit.mockImplementation(() => {
			const completing = { preventDefault: vi.fn() };
			guard.willQuit(completing);
			expect(completing.preventDefault).not.toHaveBeenCalled();
		});
		const first = { preventDefault: vi.fn() };
		guard.willQuit(first);
		const repeated = { preventDefault: vi.fn() };
		guard.willQuit(repeated);
		await Promise.resolve();
		expect(first.preventDefault).toHaveBeenCalledOnce();
		expect(repeated.preventDefault).toHaveBeenCalledOnce();
		expect(finishPreviews).toHaveBeenCalledOnce();
		expect(quit).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
		expect(onError).not.toHaveBeenCalled();
	});

	it("logs failure and releases quit", async () => {
		const error = new Error("write failed");
		const deps = {
			finishPreviews: vi.fn(async () => {
				throw error;
			}),
			quit: vi.fn(),
			onError: vi.fn(),
		};
		createWorkloadQuitGuard(deps).willQuit({ preventDefault: vi.fn() });
		await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledOnce());
		expect(deps.onError).toHaveBeenCalledWith(error);
	});

	it("bounds a stalled flush to two seconds", async () => {
		vi.useFakeTimers();
		const deps = {
			finishPreviews: () => new Promise<void>(() => undefined),
			quit: vi.fn(),
			onError: vi.fn(),
		};
		createWorkloadQuitGuard(deps).willQuit({ preventDefault: vi.fn() });
		await vi.advanceTimersByTimeAsync(1_999);
		expect(deps.quit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(deps.quit).toHaveBeenCalledOnce();
		expect(deps.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Workload report flush timed out" }),
		);
	});

	it("does not hold system logout or shutdown", () => {
		const deps = { finishPreviews: vi.fn(async () => undefined), quit: vi.fn(), onError: vi.fn() };
		const guard = createWorkloadQuitGuard(deps);
		guard.systemPoweringOff();
		const event = { preventDefault: vi.fn() };
		guard.willQuit(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(deps.finishPreviews).not.toHaveBeenCalled();
	});
});

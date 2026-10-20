import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESUME_SETTLE_MS, startEntitlementRevalidation } from "./revalidation";

const HOUR_MS = 60 * 60 * 1_000;

describe("startEntitlementRevalidation", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function start() {
		const refresh = vi.fn(async () => undefined);
		let resume: (() => void) | undefined;
		const removeResume = vi.fn();
		const stop = startEntitlementRevalidation({
			refresh,
			intervalMs: 12 * HOUR_MS,
			onResume: (listener) => {
				resume = listener;
				return removeResume;
			},
		});
		return { refresh, stop, removeResume, resume: () => resume?.() };
	}

	it("revalidates every interval while the app stays open", async () => {
		const { refresh, stop } = start();
		await vi.advanceTimersByTimeAsync(12 * HOUR_MS - 1);
		expect(refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(7 * 24 * HOUR_MS);
		expect(refresh).toHaveBeenCalledTimes(15);
		stop();
	});

	it("revalidates once shortly after the Mac wakes, however often it wakes", async () => {
		const { refresh, stop, resume } = start();
		resume();
		resume();
		await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS - 1);
		resume();
		await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS);
		expect(refresh).toHaveBeenCalledTimes(1);
		stop();
	});

	it("keeps running when a check fails", async () => {
		const { refresh, stop } = start();
		refresh.mockRejectedValueOnce(new Error("offline"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
		stop();
	});

	it("stops every timer and the resume listener", async () => {
		const { refresh, stop, resume, removeResume } = start();
		resume();
		stop();
		await vi.advanceTimersByTimeAsync(48 * HOUR_MS);
		expect(refresh).not.toHaveBeenCalled();
		expect(removeResume).toHaveBeenCalledOnce();
	});
});

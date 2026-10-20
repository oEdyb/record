import { describe, expect, it, vi } from "vitest";
import {
	MINIMUM_START_FREE_BYTES,
	PAUSE_FREE_BYTES,
	RecordingStorageMonitor,
	storageStartError,
} from "./recordingStorage";

const MB = 1024 ** 2;

function monitorWith(freeSequence: number[]) {
	let now = 0;
	const onLow = vi.fn();
	const onCritical = vi.fn();
	const monitor = new RecordingStorageMonitor({
		directory: "/recordings",
		now: () => now,
		freeBytes: vi.fn(async () => freeSequence.shift() ?? 0),
		onLow,
		onCritical,
	});
	return {
		monitor,
		onLow,
		onCritical,
		advance: async (ms: number) => {
			now += ms;
			await monitor.poll();
		},
	};
}

describe("recording storage", () => {
	it("refuses a start below the floor and allows one above it", () => {
		expect(storageStartError(MINIMUM_START_FREE_BYTES - 1)).toMatch(/Free at least 1\.0 GB/);
		expect(storageStartError(MINIMUM_START_FREE_BYTES)).toBeNull();
	});

	it("warns once at five and at one minute left at the measured write rate", async () => {
		// 10 MB/s: each 5 s poll uses 50 MB.
		const start = PAUSE_FREE_BYTES + 3_000 * MB;
		const sequence = Array.from({ length: 70 }, (_, index) => start - index * 50 * MB);
		const { onLow, onCritical, advance } = monitorWith(sequence);
		await advance(0);
		await advance(5_000);
		expect(onLow).toHaveBeenCalledTimes(1);
		expect(onLow.mock.calls[0][0].minutesLeft).toBeCloseTo(4.92, 1);
		for (let index = 0; index < 4; index += 1) await advance(5_000);
		expect(onLow).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 50; index += 1) await advance(5_000);
		expect(onLow).toHaveBeenCalledTimes(2);
		expect(onCritical).not.toHaveBeenCalled();
	});

	it("asks for one Pause below the pause floor until a new clip re-arms it", async () => {
		const { monitor, onCritical, advance } = monitorWith([
			PAUSE_FREE_BYTES - 1,
			PAUSE_FREE_BYTES - 1,
			PAUSE_FREE_BYTES - 1,
		]);
		await advance(0);
		await advance(5_000);
		expect(onCritical).toHaveBeenCalledTimes(1);
		monitor.rearm();
		await advance(5_000);
		expect(onCritical).toHaveBeenCalledTimes(2);
	});

	it("does not warn while nothing is being written", async () => {
		const { onLow, advance } = monitorWith([2_000 * MB, 2_000 * MB, 2_000 * MB]);
		await advance(0);
		await advance(5_000);
		await advance(5_000);
		expect(onLow).not.toHaveBeenCalled();
	});
});

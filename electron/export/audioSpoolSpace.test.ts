import { describe, expect, it } from "vitest";
import { assertAudioSpoolSpace, audioSpoolPeakBytes } from "./audioSpoolSpace";

describe("audio spool space", () => {
	it("bounds the peak by three program lengths or two plus the longest take", () => {
		const perSecond = 48_000 * 8;
		expect(audioSpoolPeakBytes([3600])).toBe(4 * 3600 * perSecond);
		expect(audioSpoolPeakBytes([600, 600, 600])).toBe(3 * 1800 * perSecond);
		expect(audioSpoolPeakBytes([])).toBe(0);
	});

	it("refuses before rendering when the temp disk cannot hold the audio", async () => {
		await expect(
			assertAudioSpoolSpace([3600], "/tmp", async () => 1_000_000_000n),
		).rejects.toMatchObject({ code: "INSUFFICIENT_SPACE", phase: "preflight" });
		await expect(
			assertAudioSpoolSpace([3600], "/tmp", async () => 10_000_000_000n),
		).resolves.toBeUndefined();
	});
});

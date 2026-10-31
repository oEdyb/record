import { describe, expect, it } from "vitest";
import { cameraFollowAction } from "./followCamera";

const base = { seeking: false, playing: true, baseRate: 1 };

describe("cameraFollowAction", () => {
	it("waits while a seek is still landing instead of seeking again", () => {
		expect(cameraFollowAction({ ...base, cameraTime: 1, targetTime: 3, seeking: true })).toEqual({
			kind: "wait",
		});
	});

	it("nudges the rate for small drift while playing, so the camera keeps painting", () => {
		const behind = cameraFollowAction({ ...base, cameraTime: 9.8, targetTime: 10 });
		const ahead = cameraFollowAction({ ...base, cameraTime: 10.2, targetTime: 10 });
		expect(behind.kind).toBe("rate");
		expect(ahead.kind).toBe("rate");
		if (behind.kind === "rate" && ahead.kind === "rate") {
			expect(behind.rate).toBeGreaterThan(1);
			expect(ahead.rate).toBeLessThan(1);
			expect(behind.rate).toBeLessThanOrEqual(1.1);
		}
	});

	it("seeks on a real jump", () => {
		expect(cameraFollowAction({ ...base, cameraTime: 2, targetTime: 10 })).toEqual({
			kind: "seek",
			to: 10,
		});
	});

	it("matches the still frame exactly when paused", () => {
		expect(
			cameraFollowAction({ ...base, playing: false, cameraTime: 9.8, targetTime: 10 }),
		).toEqual({ kind: "seek", to: 10 });
		expect(
			cameraFollowAction({ ...base, playing: false, cameraTime: 10.01, targetTime: 10 }),
		).toEqual({ kind: "rate", rate: 1 });
	});

	it("follows the screen's playback speed", () => {
		const action = cameraFollowAction({ ...base, baseRate: 2, cameraTime: 10, targetTime: 10 });
		expect(action).toEqual({ kind: "rate", rate: 2 });
	});
});

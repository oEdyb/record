import { describe, expect, it } from "vitest";
import {
	compareProfiles,
	completedStopSince,
	createTerminalFixture,
	median,
	parseProfileArgs,
	reviewMatchesRecording,
} from "./overnight-recording-profile-utils.mjs";

describe("recording performance proof", () => {
	it("generates a moving terminal whose browser script parses", () => {
		const html = createTerminalFixture("owned fixture");
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
		expect(html).toContain("<title>owned fixture</title>");
		expect(script).toContain("requestAnimationFrame");
		expect(() => new Function(script)).not.toThrow();
	});
	it("requires review playback to contain the newly stopped recording", () => {
		expect(reviewMatchesRecording(2.1, 120.12)).toBe(false);
		expect(reviewMatchesRecording(120.1, 120.12)).toBe(true);
		expect(reviewMatchesRecording(Number.NaN, 120.12)).toBe(false);
	});
	it("does not accept an earlier Stop while the latest recording is finalizing", () => {
		const previous = {
			name: "stop-native-mac-recording",
			finishedAt: 10,
			result: { success: true },
		};
		const history = [previous, { name: "start-native-mac-recording", finishedAt: 20 }];
		expect(completedStopSince(history, 1)).toBeNull();
		const current = { ...previous, finishedAt: 30 };
		expect(completedStopSince([...history, current], 1)).toBe(current);
		expect(completedStopSince([...history, { name: previous.name }], 1)).toBeNull();
	});
	it("keeps explicit false flags false and accepts fractional clip durations", () => {
		expect(parseProfileArgs(["--static", "false", "--durations", "0.3,2,120"])).toEqual({
			static: "false",
			durations: "0.3,2,120",
		});
	});
	it.each([
		["--unknown", "true"],
		["--pause"],
		["--pause", "yes"],
		["--durations", "0,120"],
		["--durations", "NaN"],
		["--phase", "release"],
		["--audio", "camera"],
	])("rejects unsupported or invalid options %j", (...argv) => {
		expect(() => parseProfileArgs(argv)).toThrow();
	});
	it("computes a median without changing the raw measurements", () => {
		const values = [3, 1, 2];
		expect(median(values)).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(values).toEqual([3, 1, 2]);
		expect(() => median([])).toThrow();
	});
	function report(start, exported) {
		return {
			status: "passed",
			sourceSha256: "a".repeat(64),
			recordings: [start, start + 1, start - 1].map((clickToRecordingMs) => ({
				clickToRecordingMs,
			})),
			sourceProbe: { format: { duration: "120.1" } },
			export: { wallMs: exported, probe: { format: { duration: "120.1" } } },
		};
	}
	it("requires both timings to improve independently", () => {
		expect(compareProfiles(report(2300, 60000), report(300, 1000))).toMatchObject({
			recordBeforeMs: 2300,
			recordAfterMs: 300,
			bothFaster: true,
		});
		expect(compareProfiles(report(2300, 60000), report(300, 60001)).bothFaster).toBe(false);
	});
	it("rejects failed, incomplete, or short recordings as performance proof", () => {
		const before = report(2300, 60000);
		for (const invalid of [
			{ ...before, status: "failed" },
			{ ...before, recordings: before.recordings.slice(1) },
			{ ...before, sourceProbe: { format: { duration: "2" } } },
			{ ...before, sourceProbe: {} },
			{ ...before, sourceSha256: "b".repeat(64) },
			{ ...before, export: { wallMs: 1000, probe: { format: { duration: "2.1" } } } },
			{ ...before, export: null },
		])
			expect(() => compareProfiles(before, invalid)).toThrow();
	});
});

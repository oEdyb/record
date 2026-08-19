import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "../native/contracts";
import {
	compactCursorRecordingPauseRanges,
	getKeptRecordingDurationMs,
	getNativeMacRecordingIdFromClipPath,
	mergeNativeMacStoppedClips,
	removePreviousNativeMacClip,
	shiftCursorRecordingToVideoStart,
	splitCursorRecordingForClips,
} from "./nativeMacClipSession";

const clips = [
	{ index: 0, screenVideoPath: "/tmp/clip-1.mp4", durationMs: 1000 },
	{ index: 1, screenVideoPath: "/tmp/clip-2.mp4", durationMs: 2000 },
];

describe("native macOS clip session", () => {
	it("counts only kept clips in the visible recording duration", () => {
		expect(
			getKeptRecordingDurationMs([
				clips[0],
				{ ...clips[1], removed: true },
				{ index: 2, screenVideoPath: "/tmp/clip-3.mp4", durationMs: 750 },
			]),
		).toBe(1_750);
	});

	it("maps every clip in a recording to one canonical session id", () => {
		expect(getNativeMacRecordingIdFromClipPath("/tmp/recording-123-clip-0001.mp4")).toBe(123);
		expect(getNativeMacRecordingIdFromClipPath("C:\\tmp\\recording-123-clip-0042.mp4")).toBe(123);
		expect(getNativeMacRecordingIdFromClipPath("/tmp/recording-123.mp4")).toBeNull();
	});

	it("removes completed clips from newest to oldest without deleting metadata", () => {
		const first = removePreviousNativeMacClip(clips);
		expect(first.removed).toMatchObject({ index: 1, removed: true });
		expect(first.clips).toHaveLength(2);

		const second = removePreviousNativeMacClip(first.clips);
		expect(second.removed).toMatchObject({ index: 0, removed: true });
		expect(removePreviousNativeMacClip(second.clips).removed).toBeUndefined();
	});

	it("preserves removal state when Stop reports the helper's authoritative clip list", () => {
		const known = [{ ...clips[0], removed: true }, clips[1]];
		expect(mergeNativeMacStoppedClips(clips, known)).toEqual([
			{ ...clips[0], removed: true },
			clips[1],
		]);
	});

	it("splits continuous cursor telemetry onto each clip and rebases its time", () => {
		const recording: CursorRecordingData = {
			version: 2,
			provider: "native",
			assets: [],
			samples: [
				{ timeMs: 0, cx: 0, cy: 0 },
				{ timeMs: 999, cx: 0.2, cy: 0.2 },
				{ timeMs: 1000, cx: 0.4, cy: 0.4 },
				{ timeMs: 2999, cx: 0.8, cy: 0.8 },
			],
			keyboardActivity: [
				{ timeMs: 500, cx: 0.2, cy: 0.2, count: 1 },
				{ timeMs: 1_200, cx: 0.4, cy: 0.4, count: 2 },
			],
		};

		const split = splitCursorRecordingForClips(recording, clips);
		expect(split[0].recording.samples.map((sample) => sample.timeMs)).toEqual([0, 999]);
		expect(split[1].recording.samples.map((sample) => sample.timeMs)).toEqual([0, 1999]);
		expect(split[0].recording.keyboardActivity?.map((sample) => sample.timeMs)).toEqual([500]);
		expect(split[1].recording.keyboardActivity?.map((sample) => sample.timeMs)).toEqual([200]);
	});

	it("drops pre-video input while keeping one neutral cursor seed", () => {
		const shifted = shiftCursorRecordingToVideoStart(
			{
				version: 3,
				provider: "native",
				assets: [],
				samples: [
					{ timeMs: 50, cx: 0.2, cy: 0.2, interactionType: "click" },
					{ timeMs: 250, cx: 0.3, cy: 0.3, interactionType: "mouseup" },
					{ timeMs: 500, cx: 0.4, cy: 0.4, interactionType: "move" },
				],
				keyboardActivity: [
					{ timeMs: 100, cx: 0.2, cy: 0.2, count: 2 },
					{ timeMs: 200, cx: 0.2, cy: 0.2, count: 2 },
					{ timeMs: 600, cx: 0.6, cy: 0.6, count: 1 },
				],
			},
			300,
		);

		expect(shifted.samples).toEqual([
			{ timeMs: 0, cx: 0.3, cy: 0.3, interactionType: "move" },
			{ timeMs: 200, cx: 0.4, cy: 0.4, interactionType: "move" },
		]);
		expect(shifted.keyboardActivity).toEqual([{ timeMs: 300, cx: 0.6, cy: 0.6, count: 1 }]);
	});

	it("removes paused pointer and keyboard activity and compacts later time", () => {
		const compacted = compactCursorRecordingPauseRanges(
			{
				version: 3,
				provider: "native",
				assets: [],
				samples: [
					{ timeMs: 500, cx: 0.2, cy: 0.2 },
					{ timeMs: 1_500, cx: 0.4, cy: 0.4 },
					{ timeMs: 2_500, cx: 0.6, cy: 0.6 },
				],
				keyboardActivity: [
					{ timeMs: 600, cx: 0.2, cy: 0.2, count: 1 },
					{ timeMs: 1_600, cx: 0.4, cy: 0.4, count: 1 },
					{ timeMs: 2_600, cx: 0.6, cy: 0.6, count: 1 },
				],
			},
			[{ startMs: 1_000, endMs: 2_000 }],
		);

		expect(compacted.samples.map((sample) => sample.timeMs)).toEqual([500, 1_500]);
		expect(compacted.keyboardActivity?.map((sample) => sample.timeMs)).toEqual([600, 1_600]);
	});
});

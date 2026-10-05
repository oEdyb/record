import { describe, expect, it } from "vitest";
import { buildPeekTimeline, locatePeekTime, peekCameraStyle } from "./HudClipPeek";

const clips = [
	{ index: 2, screenVideoPath: "/c.mp4", durationMs: 4_000 },
	{ index: 0, screenVideoPath: "/a.mp4", durationMs: 2_000 },
	{ index: 1, screenVideoPath: "/b.mp4", durationMs: 9_000, removed: true },
];

describe("clip replay timeline", () => {
	it("lays kept clips end to end in recording order", () => {
		const timeline = buildPeekTimeline(clips);
		expect(timeline.map((entry) => [entry.clip.index, entry.start, entry.duration])).toEqual([
			[0, 0, 2],
			[2, 2, 4],
		]);
	});

	it("finds the clip and offset for a timeline position", () => {
		const timeline = buildPeekTimeline(clips);
		expect(locatePeekTime(timeline, 1)).toEqual({ index: 0, offset: 1 });
		expect(locatePeekTime(timeline, 2)).toEqual({ index: 1, offset: 0 });
		expect(locatePeekTime(timeline, 5.5)).toEqual({ index: 1, offset: 3.5 });
		expect(locatePeekTime(timeline, 99)).toEqual({ index: 1, offset: 4 });
	});
});

describe("clip replay camera", () => {
	it("draws the camera at the remembered size and spot", () => {
		const style = peekCameraStyle(
			{ webcamPosition: { cx: 0.9, cy: 0.8 }, webcamSizePreset: 25, webcamMirrored: true },
			false,
		);
		expect(style).toMatchObject({ width: "25.00cqmin", left: "90%", top: "80%", scale: "-1 1" });
		expect(style.height).toBeUndefined();
	});

	it("falls back to the bottom-right corner and sizes a portrait camera by height", () => {
		const style = peekCameraStyle(
			{ webcamPosition: null, webcamSizePreset: 25, webcamMirrored: false },
			true,
		);
		expect(style).toMatchObject({ height: "25.00cqmin", right: "2cqmin", bottom: "2cqmin" });
		expect(style.scale).toBeUndefined();
	});
});

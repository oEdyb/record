import { expect, it } from "vitest";
import type { AxcutClip } from "../schema";
import { audioOutputTime, buildAudioOutputClock } from "./audioOutputClock";

const clip = (
	id: string,
	sourceStartSec: number,
	sourceEndSec: number,
	timelineStartSec: number,
): AxcutClip => ({
	id,
	assetId: "same_source",
	sourceStartSec,
	sourceEndSec,
	timelineStartSec,
	timelineEndSec: timelineStartSec + sourceEndSec - sourceStartSec,
	wordRefs: [],
	origin: "user",
	reason: "test",
});
it("keeps a removed middle gap at its output join and includes speed in seeks", () => {
	const original = clip("first", 10, 20, 0);
	const spans = buildAudioOutputClock(
		[clip("first", 10, 12, 0), clip("first", 15, 20, 2)],
		[original],
		[{ startSec: 15, endSec: 19, speed: 2, clipIndex: 1 }],
	);
	expect(audioOutputTime(1, spans)).toBe(1);
	expect(audioOutputTime(3, spans)).toBe(2);
	expect(audioOutputTime(7, spans)).toBe(3);
	expect(audioOutputTime(10, spans)).toBe(5);
	expect(audioOutputTime(100, spans)).toBe(5);
});
it("keeps repeated source slices distinct and maps backwards seeks", () => {
	const clips = [clip("first", 10, 14, 0), clip("second", 10, 14, 4)];
	const spans = buildAudioOutputClock(clips, clips, [
		{ startSec: 10, endSec: 14, speed: 2, clipIndex: 1 },
	]);
	expect(audioOutputTime(6, spans)).toBe(5);
	expect(audioOutputTime(2, spans)).toBe(2);
	expect(audioOutputTime(-1, spans)).toBe(0);
	expect(audioOutputTime(Number.NaN, spans)).toBe(0);
});

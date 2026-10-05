import { describe, expect, it } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { recordsIntoOpenProject, reviewInsertionTime } from "./reviewInsertion";

function clip(id: string, start: number, end: number): AxcutClip {
	return {
		id,
		assetId: id,
		sourceStartSec: 0,
		sourceEndSec: end - start,
		timelineStartSec: start,
		timelineEndSec: end,
		wordRefs: [],
		origin: "system",
		reason: "",
	};
}

describe("review insertion", () => {
	const clips = [clip("a", 0, 10), clip("b", 10, 25)];

	it("keeps Record as a new recording in review and Add clip in the open one", () => {
		expect(recordsIntoOpenProject("new", true)).toBe(false);
		expect(recordsIntoOpenProject("add", true)).toBe(true);
		expect(recordsIntoOpenProject("new", false)).toBe(true);
	});

	it("adds at the end until the playhead moves, then at the nearest clip edge", () => {
		expect(reviewInsertionTime(clips, 0, false)).toBe(25);
		expect(reviewInsertionTime(clips, 3, true)).toBe(0);
		expect(reviewInsertionTime(clips, 8, true)).toBe(10);
		expect(reviewInsertionTime([], 8, false)).toBe(0);
	});
});

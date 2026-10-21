import { describe, expect, it } from "vitest";
import { resolvePlaybackSegments } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { cleanCutTrimRanges, sourceToTimeline, timelineToSource } from "./timelineMap";

function clip(
	id: string,
	assetId: string,
	sourceStartSec: number,
	sourceEndSec: number,
	timelineStartSec: number,
): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "system",
		reason: "",
	};
}

const clips = [clip("c1", "a", 10, 40, 0), clip("c2", "b", 0, 20, 30)];

describe("source and timeline time", () => {
	it("maps a source second through the clip that shows it", () => {
		expect(sourceToTimeline(clips, "a", 15)).toBe(5);
		expect(sourceToTimeline(clips, "b", 5)).toBe(35);
	});

	it("returns null for a moment no clip shows", () => {
		expect(sourceToTimeline(clips, "a", 5)).toBeNull();
		expect(sourceToTimeline(clips, "c", 5)).toBeNull();
	});

	it("maps a timeline time back to its recording", () => {
		expect(timelineToSource(clips, 5)).toEqual({ assetId: "a", sourceSec: 15 });
		expect(timelineToSource(clips, 35)).toEqual({ assetId: "b", sourceSec: 5 });
		expect(timelineToSource(clips, 99)).toBeNull();
	});

	it("round-trips", () => {
		const at = timelineToSource(clips, 12.5);
		expect(at && sourceToTimeline(clips, at.assetId, at.sourceSec)).toBe(12.5);
	});
});

describe("cleanCutTrimRanges", () => {
	const keep = [
		{ assetId: "a", startSec: 12, endSec: 20 },
		{ assetId: "a", startSec: 25, endSec: 45 },
	];

	it("trims what the covered clip shows outside the keep list", () => {
		const trims = cleanCutTrimRanges(clips, keep, new Set(["a"]));
		expect(trims.map(({ clipId, startSec, endSec }) => [clipId, startSec, endSec])).toEqual([
			["c1", 10, 12],
			["c1", 20, 25],
		]);
	});

	it("never trims a recording the clean cut did not analyse", () => {
		const trims = cleanCutTrimRanges(clips, keep, new Set(["a"]));
		expect(trims.every((trim) => trim.assetId === "a")).toBe(true);
	});

	it("plays only the kept stretches", () => {
		const segments = resolvePlaybackSegments(
			clips,
			cleanCutTrimRanges(clips, keep, new Set(["a"])),
		);
		const length = segments.reduce((sum, s) => sum + (s.timelineEndSec - s.timelineStartSec), 0);
		expect(length).toBeCloseTo(8 + 15 + 20, 6);
	});

	it("trims a whole covered clip that keeps nothing", () => {
		const trims = cleanCutTrimRanges(clips, [], new Set(["b"]));
		expect(trims).toMatchObject([{ clipId: "c2", startSec: 0, endSec: 20 }]);
	});
});

import { describe, expect, it } from "vitest";
import { type AxcutClip, createEmptyDocument } from "../schema";
import { insertClipsAtBoundary, resolveClipInsertionBoundary } from "./timeline";

function clip(id: string, start: number, end: number): AxcutClip {
	return {
		id,
		assetId: `asset-${id}`,
		sourceStartSec: 0,
		sourceEndSec: end - start,
		timelineStartSec: start,
		timelineEndSec: end,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

describe("recording timeline insertion", () => {
	it("uses an exact boundary but inserts after the section containing the playhead", () => {
		const clips = [clip("one", 0, 5), clip("two", 5, 10)];

		expect(resolveClipInsertionBoundary(clips, 0)).toBe(0);
		expect(resolveClipInsertionBoundary(clips, 5)).toBe(5);
		expect(resolveClipInsertionBoundary(clips, 0.02)).toBe(5);
		expect(resolveClipInsertionBoundary(clips, 7)).toBe(10);
	});

	it("moves every unanchored legacy modifier with its original media", () => {
		const base = createEmptyDocument({ title: "Insertion", projectId: "insert-test" });
		const document = {
			...base,
			timeline: { ...base.timeline, clips: [clip("one", 0, 5), clip("two", 5, 10)] },
			zoomRanges: [
				{
					id: "zoom-after",
					startMs: 6_000,
					endMs: 7_000,
					depth: 2 as const,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
			annotations: [
				{
					id: "annotation-crossing",
					startMs: 4_000,
					endMs: 6_000,
					type: "text" as const,
					content: "Keep me on the old clips",
					position: { x: 50, y: 50 },
					size: { width: 20, height: 10 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold" as const,
						fontStyle: "normal" as const,
						textDecoration: "none" as const,
						textAlign: "center" as const,
					},
					zIndex: 0,
				},
			],
			legacyEditor: {
				speedRegions: [{ id: "speed-after", startMs: 7_000, endMs: 8_000 }],
				cameraFullscreenRegions: [{ id: "camera-crossing", startMs: 4_500, endMs: 5_500 }],
			},
		};

		const next = insertClipsAtBoundary(document, [clip("new", 0, 2)], 5);

		expect(next.zoomRanges).toMatchObject([{ startMs: 8_000, endMs: 9_000 }]);
		expect(next.annotations).toMatchObject([
			{ startMs: 4_000, endMs: 5_000 },
			{ startMs: 7_000, endMs: 8_000 },
		]);
		const legacy = next.legacyEditor as {
			speedRegions: Array<{ startMs: number; endMs: number }>;
			cameraFullscreenRegions: Array<{ startMs: number; endMs: number }>;
		};
		expect(legacy.speedRegions).toMatchObject([{ startMs: 9_000, endMs: 10_000 }]);
		expect(legacy.cameraFullscreenRegions).toMatchObject([
			{ startMs: 4_500, endMs: 5_000 },
			{ startMs: 7_000, endMs: 7_500 },
		]);
	});

	it("splits old timeline ranges around new media instead of applying them to it", () => {
		const base = createEmptyDocument({ title: "Ranges", projectId: "range-test" });
		const document = {
			...base,
			timeline: {
				...base.timeline,
				clips: [clip("one", 0, 5), clip("two", 5, 10)],
				muteRanges: [{ startSec: 4, endSec: 6, reason: "crossing" }],
				speedRanges: [{ startSec: 7, endSec: 8, reason: "after" }],
			},
		};

		const next = insertClipsAtBoundary(document, [clip("new", 0, 2)], 5);

		expect(next.timeline.muteRanges).toEqual([
			{ startSec: 4, endSec: 5, reason: "crossing" },
			{ startSec: 7, endSec: 8, reason: "crossing" },
		]);
		expect(next.timeline.speedRanges).toEqual([{ startSec: 9, endSec: 10, reason: "after" }]);
	});
});

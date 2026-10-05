// Cross-layer regression for the one bug class the unit tests can each only see a
// third of: a scene with TWO clips over the SAME media. Source time is per asset, so
// the two clips share a coordinate space, and a cut authored on the second used to be
// read back differently by every consumer — struck through in BOTH transcript blocks,
// drawn on the FIRST clip's ruler, and removed from BOTH clips in playback/export.
//
// This reads one stored clip-scoped trim through the kept readers (ruler and
// playback/export) and asserts they agree. The authoring operation and the transcript
// pane that once completed this walk were archived at archive/pre-cleanup-2026-10-05.
import { describe, expect, it } from "vitest";
import { resolvePlaybackSegments } from "@/lib/ai-edition/document/timeline";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";

function doc(): AxcutDocument {
	const base = createEmptyDocument({ title: "repro", projectId: "p" });
	const asset = {
		id: "asset_1",
		kind: "video" as const,
		label: "recording-1785529823210.mp4",
		originalPath: "/rec.mp4",
		durationSec: 11.8,
		cameraTrack: null,
	};
	const clip = (id: string, at: number) => ({
		id,
		assetId: asset.id,
		sourceStartSec: 0,
		sourceEndSec: 11.8,
		timelineStartSec: at,
		timelineEndSec: at + 11.8,
		wordRefs: [],
		origin: "user" as const,
		reason: "",
	});
	return {
		...base,
		project: { ...base.project, primaryAssetId: asset.id },
		assets: [asset],
		transcripts: [
			{
				assetId: asset.id,
				language: "fr",
				sources: [],
				segments: [],
				words: [
					{ id: "w1", segmentId: "s", startSec: 1.3, endSec: 3.0, text: "Salut, comment ça va ?" },
					{ id: "w2", segmentId: "s", startSec: 3.4, endSec: 5.0, text: "Ben voilà, c'est tout ?" },
					{ id: "w3", segmentId: "s", startSec: 5.0, endSec: 6.7, text: "Ben voilà." },
					{ id: "w4", segmentId: "s", startSec: 8.4, endSec: 10.4, text: "*sifflement*" },
				],
			},
		],
		timeline: { ...base.timeline, clips: [clip("clip_1", 0), clip("clip_2", 11.8)] },
	};
}

describe("repro: trim on clip 2 of two clips sharing one media", () => {
	it("lands on clip 2 only, on the ruler and in playback", () => {
		// A stored trim over "*sifflement*" in CLIP 2, as existing projects persist it.
		const base = doc();
		const next: AxcutDocument = {
			...base,
			timeline: {
				...base.timeline,
				trimRanges: [
					{
						id: "trim_clip_2_1",
						assetId: "asset_1",
						clipId: "clip_2",
						startSec: 8.4,
						endSec: 10.4,
						reason: "Skip from transcript",
						origin: "user",
					},
				],
			},
		};

		// 1. Ruler — one pill, over clip 2 (timeline 11.8 + 8.4 = 20.2 … 22.2).
		const pills = coalescedTrimGroups(next.timeline.trimRanges, next.timeline.clips);
		expect(pills).toHaveLength(1);
		expect(pills[0].start).toBeCloseTo(20.2, 6);
		expect(pills[0].end).toBeCloseTo(22.2, 6);

		// 2. Playback / export — clip 1 whole, clip 2 split around the cut.
		const segs = resolvePlaybackSegments(next.timeline.clips, next.timeline.trimRanges);
		expect(segs.map((s) => s.id)).toEqual(["clip_1", "clip_2_seg1", "clip_2_seg2"]);
		expect(segs.at(-1)?.timelineEndSec).toBeCloseTo(21.6, 6); // 23.6 − 2s cut, once.
	});
});

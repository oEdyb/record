import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../schema";
import type { PauseSuggestion } from "../timeline/pause-analysis";
import { applyPauseSuggestions } from "./pause-edits";

function fixture() {
	const document = createEmptyDocument({ projectId: "project_1", title: "Test" });
	document.assets.push({
		id: "asset_1",
		kind: "video",
		label: "Recording",
		originalPath: "/recording.mp4",
		durationSec: 10,
		cameraTrack: null,
	});
	document.timeline.clips.push({
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	});
	return document;
}

const suggestion: PauseSuggestion = {
	id: "pause_clip_1_2000_4000",
	kind: "pause",
	clipId: "clip_1",
	assetId: "asset_1",
	silenceStartSec: 1.8,
	silenceEndSec: 4.2,
	sourceStartSec: 2,
	sourceEndSec: 4,
	timelineStartSec: 2,
	timelineEndSec: 4,
	savedSec: 2,
};

describe("pause edits", () => {
	it("adds confirmed candidates as normal user trims", () => {
		const next = applyPauseSuggestions(fixture(), [suggestion]);
		expect(next.timeline.trimRanges).toEqual([
			expect.objectContaining({
				id: suggestion.id,
				clipId: "clip_1",
				origin: "user",
				reason: "Shortened pause",
			}),
		]);
	});

	it("is retry-safe and keeps a newer overlapping user trim", () => {
		const document = fixture();
		document.timeline.trimRanges.push({
			id: "manual",
			assetId: "asset_1",
			clipId: "clip_1",
			startSec: 2.5,
			endSec: 3,
			reason: "manual",
			origin: "user",
		});
		expect(applyPauseSuggestions(document, [suggestion])).toBe(document);
	});
});

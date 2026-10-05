import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { selectReviewPreviewRegions } from "./reviewPreviewRegions";

function editedDocument() {
	const document = createEmptyDocument({ title: "Edited", projectId: "p1" });
	document.zoomRanges = [{ id: "z1", startMs: 0, endMs: 1000 } as (typeof document.zoomRanges)[0]];
	document.timeline.trimRanges = [
		{ id: "t1", assetId: "a1", startSec: 1, endSec: 2 } as (typeof document.timeline.trimRanges)[0],
	];
	document.legacyEditor = {
		speedRegions: [{ id: "s1", startMs: 0, endMs: 500, speed: 1.5 }],
		cameraFullscreenRegions: [{ id: "f1", startMs: 500, endMs: 900 }],
	};
	return document;
}

describe("review preview regions", () => {
	it("reads zooms, trims, speed and Full Camera regions from an edited document", () => {
		const document = editedDocument();
		expect(selectReviewPreviewRegions(document, "p1")).toEqual({
			zoomRegions: document.zoomRanges,
			trimRanges: document.timeline.trimRanges,
			speedRegions: [{ id: "s1", startMs: 0, endMs: 500, speed: 1.5 }],
			cameraFullscreenRegions: [{ id: "f1", startMs: 500, endMs: 900 }],
		});
	});

	it("reads legacy speed and Full Camera regions only once a project id is loaded", () => {
		const document = editedDocument();
		const regions = selectReviewPreviewRegions(document, null);
		expect(regions.zoomRegions).toEqual(document.zoomRanges);
		expect(regions.trimRanges).toEqual(document.timeline.trimRanges);
		expect(regions.speedRegions).toEqual([]);
		expect(regions.cameraFullscreenRegions).toEqual([]);
	});

	it("returns empty regions without a document or legacy editor state", () => {
		expect(selectReviewPreviewRegions(null, null)).toEqual({
			zoomRegions: [],
			trimRanges: [],
			speedRegions: [],
			cameraFullscreenRegions: [],
		});
		const plain = createEmptyDocument({ title: "Plain", projectId: "p2" });
		expect(selectReviewPreviewRegions(plain, "p2").speedRegions).toEqual([]);
	});
});

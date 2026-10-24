import { expect, it } from "vitest";
import { cleanCutTimeline, parseCleanCut } from "./cleanCutSpans";
import type { HandoffSpan } from "./sourceTimeline";

const retained: HandoffSpan[] = [
	{
		id: "a1",
		assetId: "a",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
	},
	{
		id: "b1",
		assetId: "b",
		sourceStartSec: 2,
		sourceEndSec: 8,
		timelineStartSec: 10,
		timelineEndSec: 16,
	},
];

it("lays kept stretches end to end in edit order and puts each marker where its stretch starts", () => {
	const { spans, markers } = cleanCutTimeline(retained, {
		keep: [
			{ assetId: "a", startSec: 1, endSec: 4 },
			{ assetId: "a", startSec: 6, endSec: 9 },
			{ assetId: "b", startSec: 3, endSec: 5 },
		],
		markers: [{ keepIndex: 2, name: "Retake", comment: "said again", color: "RED" }],
	});
	expect(
		spans.map((s) => [s.assetId, s.sourceStartSec, s.sourceEndSec, s.timelineStartSec]),
	).toEqual([
		["a", 1, 4, 0],
		["a", 6, 9, 3],
		["b", 3, 5, 6],
	]);
	expect(markers).toEqual([
		{ name: "Retake", comment: "said again", color: "RED", timelineSec: 6 },
	]);
});

it("never brings back material the project already removed", () => {
	const { spans, markers } = cleanCutTimeline(retained, {
		keep: [
			{ assetId: "b", startSec: 0, endSec: 3 },
			{ assetId: "b", startSec: 9, endSec: 12 },
		],
		markers: [{ keepIndex: 1, name: "Filler", comment: "", color: "GREEN" }],
	});
	expect(spans.map((s) => [s.sourceStartSec, s.sourceEndSec])).toEqual([[2, 3]]);
	expect(markers).toEqual([]);
});

it("accepts a well-formed clean cut from the renderer and rejects anything else", () => {
	const good = {
		keep: [{ assetId: "a", startSec: 0, endSec: 2 }],
		markers: [{ keepIndex: 0, name: "Retake", comment: "", color: "RED" }],
	};
	expect(parseCleanCut(good)).toEqual(good);
	expect(parseCleanCut(undefined)).toBeUndefined();
	for (const bad of [
		{ keep: "x", markers: [] },
		{ keep: [{ assetId: "a", startSec: 3, endSec: 1 }], markers: [] },
		{ keep: [], markers: [{ keepIndex: 0.5, name: "", comment: "", color: "RED" }] },
		{ keep: [], markers: [{ keepIndex: 0, name: "", comment: "", color: "black" }] },
	])
		expect(() => parseCleanCut(bad)).toThrow("not valid");
});

it("shortens a long marker note instead of rejecting the export", () => {
	const long = "Retake (the speaker tried again): “now the cloud.md file tells you” / ".repeat(20);
	const parsed = parseCleanCut({
		keep: [{ assetId: "a", startSec: 0, endSec: 2 }],
		markers: [{ keepIndex: 0, name: "Retake", comment: long, color: "ORANGE" }],
	});
	expect(parsed?.markers[0]?.comment).toHaveLength(500);
	expect(parsed?.markers[0]?.comment.endsWith("…")).toBe(true);
	expect(() =>
		parseCleanCut({ keep: [{ assetId: "a".repeat(501), startSec: 0, endSec: 1 }], markers: [] }),
	).toThrow("not valid");
});

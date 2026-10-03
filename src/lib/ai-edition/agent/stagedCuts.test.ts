import { expect, it } from "vitest";
import { editFixture } from "../checks/fixtures";
import { applyPauseSuggestions } from "../document/pause-edits";
import { cutsFromOperations } from "./stagedCuts";

it("stages setTrim without mutation and replaces the exact original on acceptance", () => {
	const document = editFixture({ trims: [[2, 4]] });
	const original = JSON.stringify(document);
	const cuts = cutsFromOperations(
		document,
		[{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 2.5, endSec: 5 } }],
		"plan",
	);
	expect(JSON.stringify(document)).toBe(original);
	expect(cuts[0].id).not.toContain(",");
	expect(applyPauseSuggestions(document, cuts).timeline.trimRanges).toEqual([
		expect.objectContaining({ id: "trim_0", startSec: 2.5, endSec: 5 }),
	]);
	document.timeline.trimRanges[0] = { ...document.timeline.trimRanges[0], endSec: 4.5 };
	expect(applyPauseSuggestions(document, cuts)).toBe(document);
});
it("validates the whole plan before staging any operation", () => {
	const document = editFixture();
	expect(() =>
		cutsFromOperations(
			document,
			[
				{ type: "addTrim", args: { clipId: "clip", startSec: 1, endSec: 3 } },
				{ type: "addTrim", args: { clipId: "clip", startSec: 15, endSec: 25 } },
			],
			"plan",
		),
	).toThrow("fit one clip");
});

it("never emits duplicate trim IDs from repeated replacement or resized proposals", () => {
	const document = editFixture({ trims: [[2, 4]] });
	const cuts = cutsFromOperations(
		document,
		[
			{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 2, endSec: 3 } },
			{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 6, endSec: 7 } },
		],
		"plan",
	);
	expect(applyPauseSuggestions(document, cuts).timeline.trimRanges).toHaveLength(1);
	const first = {
		id: "same",
		clipId: "clip",
		assetId: "asset",
		sourceStartSec: 8,
		sourceEndSec: 9,
	};
	const accepted = applyPauseSuggestions(document, [first]);
	const second = applyPauseSuggestions(accepted, [
		{ ...first, sourceStartSec: 10, sourceEndSec: 11 },
	]);
	expect(second.timeline.trimRanges).toHaveLength(3);
	expect(new Set(second.timeline.trimRanges.map((trim) => trim.id)).size).toBe(3);
});

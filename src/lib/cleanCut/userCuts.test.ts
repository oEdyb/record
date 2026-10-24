import { describe, expect, it } from "vitest";
import { applyRestores } from "./keep";
import { type CleanCutWord, EMPTY_CLEAN_CUT_SNAPSHOT } from "./types";
import { sentenceAround, userCutRegion, withUserCuts } from "./userCuts";

const word = (text: string, startSec: number, regionId: string | null = null): CleanCutWord => ({
	text,
	assetId: "a",
	startSec,
	endSec: startSec + 0.4,
	regionId,
});

const words = [
	word("Hi", 0),
	word("there.", 0.5),
	word("And", 2),
	word("then", 2.5),
	word("more.", 3),
	word("Um", 4, "a:5"),
	word("Done.", 5),
];
const keep = [
	{ assetId: "a", startSec: 0, endSec: 3.9 },
	{ assetId: "a", startSec: 4.8, endSec: 6 },
];

describe("cutting a sentence yourself", () => {
	it("finds the kept sentence around a word and stops at sentence ends and cuts", () => {
		expect(sentenceAround(words, 3)).toEqual([2, 4]);
		expect(sentenceAround(words, 0)).toEqual([0, 1]);
		expect(sentenceAround(words, 6)).toEqual([6, 6]);
		expect(sentenceAround(words, 5)).toBeNull();
	});

	it("cuts halfway into the pauses around it, inside what the engine kept", () => {
		const region = userCutRegion(words, keep, 2, 4);
		expect(region).toMatchObject({
			id: "user:a:2",
			kind: "manual",
			removedStartSec: 1.45,
			words: ["And", "then", "more."],
			sources: ["user"],
		});
		expect(region.removedEndSec).toBeCloseTo(3.7);
	});

	it("takes the sentence out of what plays, marks its words, and restores to the same keep", () => {
		const base = { ...EMPTY_CLEAN_CUT_SNAPSHOT, keep, words, regions: [] };
		const region = userCutRegion(words, keep, 2, 4);
		const cut = withUserCuts(base, [region]);
		expect(cut.keep).toEqual([
			{ assetId: "a", startSec: 0, endSec: 1.45 },
			{ assetId: "a", startSec: region.removedEndSec, endSec: 3.9 },
			{ assetId: "a", startSec: 4.8, endSec: 6 },
		]);
		expect(cut.words.map((w) => w.regionId)).toEqual([
			null,
			null,
			"user:a:2",
			"user:a:2",
			"user:a:2",
			"a:5",
			null,
		]);
		expect(cut.regions).toEqual([region]);
		expect(applyRestores(cut.keep, cut.regions, [region.id])).toEqual(keep);
	});
});

import { describe, expect, it } from "vitest";
import { activeRegions, applyRestores, effectiveKeep, keepDurationSec } from "./keep";
import type { CleanCutKeep, CleanCutRegion } from "./types";

const keep: CleanCutKeep[] = [
	{ assetId: "a", startSec: 1, endSec: 10 },
	{ assetId: "a", startSec: 12, endSec: 20 },
	{ assetId: "a", startSec: 25, endSec: 30 },
];

function region(
	id: string,
	removedStartSec: number,
	removedEndSec: number,
	extra: Partial<CleanCutRegion> = {},
): CleanCutRegion {
	return {
		id,
		kind: "retake",
		assetId: "a",
		removedStartSec,
		removedEndSec,
		words: ["so"],
		reason: "",
		sources: ["model", "session"],
		risky: false,
		...extra,
	};
}

const regions = [
	region("head", 0, 1, { kind: "pause", sources: ["rule"] }),
	region("r1", 10, 12),
	region("r2a", 20, 22, { sources: ["model"] }),
	region("r2b", 22, 25),
];

describe("applyRestores", () => {
	it("keeps the list unchanged when nothing is restored", () => {
		expect(applyRestores(keep, regions, [])).toEqual(keep);
	});

	it("fills a restored cut and joins the stretches on both sides", () => {
		expect(applyRestores(keep, regions, ["r1"])).toEqual([
			{ assetId: "a", startSec: 1, endSec: 20 },
			{ assetId: "a", startSec: 25, endSec: 30 },
		]);
	});

	it("joins only once every region between two stretches is back", () => {
		expect(applyRestores(keep, regions, ["r2a"])).toEqual([
			{ assetId: "a", startSec: 1, endSec: 10 },
			{ assetId: "a", startSec: 12, endSec: 22 },
			{ assetId: "a", startSec: 25, endSec: 30 },
		]);
		expect(applyRestores(keep, regions, ["r2a", "r2b"])).toEqual([
			{ assetId: "a", startSec: 1, endSec: 10 },
			{ assetId: "a", startSec: 12, endSec: 30 },
		]);
	});

	it("restores the head before the first stretch", () => {
		expect(applyRestores(keep, regions, new Set(["head"]))[0]).toEqual({
			assetId: "a",
			startSec: 0,
			endSec: 10,
		});
	});

	it("leaves other recordings' stretches in their edit order", () => {
		const mixed: CleanCutKeep[] = [
			{ assetId: "a", startSec: 0, endSec: 5 },
			{ assetId: "b", startSec: 0, endSec: 4 },
			{ assetId: "a", startSec: 8, endSec: 9 },
		];
		const gap = region("g", 5, 8);
		expect(applyRestores(mixed, [gap], ["g"])).toEqual([
			{ assetId: "a", startSec: 0, endSec: 8 },
			{ assetId: "b", startSec: 0, endSec: 4 },
			{ assetId: "a", startSec: 8, endSec: 9 },
		]);
	});
});

describe("strength", () => {
	it("Gentle cuts only word cuts two checks agree on, and every pause", () => {
		const ids = activeRegions(regions, "gentle", new Set()).map((r) => r.id);
		expect(ids).toEqual(["head", "r1", "r2b"]);
	});

	it("Clean cuts everything not restored", () => {
		expect(activeRegions(regions, "clean", new Set(["r1"])).map((r) => r.id)).toEqual([
			"head",
			"r2a",
			"r2b",
		]);
	});

	it("Gentle brings back what it does not cut", () => {
		const gentle = effectiveKeep(keep, regions, "gentle", new Set());
		expect(gentle).toEqual([
			{ assetId: "a", startSec: 1, endSec: 10 },
			{ assetId: "a", startSec: 12, endSec: 22 },
			{ assetId: "a", startSec: 25, endSec: 30 },
		]);
		expect(keepDurationSec(gentle)).toBe(9 + 10 + 5);
	});
});

import { describe, expect, it } from "vitest";
import type { CleanCutRegion, CleanCutWord } from "@/lib/cleanCut/types";
import { cutContext } from "./hudContext";

const word = (text: string, regionId: string | null = null): CleanCutWord => ({
	text,
	assetId: "a",
	startSec: 0,
	endSec: 0,
	regionId,
});
const region = (id: string, words: string[]): CleanCutRegion => ({
	id,
	kind: "retake",
	assetId: "a",
	removedStartSec: 0,
	removedEndSec: 1,
	words,
	reason: "",
	sources: ["rule"],
	risky: true,
});

describe("cutContext", () => {
	it("reads the words around a cut and marks other active cuts", () => {
		const words = [word("so"), word("um", "r0"), word("this"), word("this", "r1"), word("works")];
		const context = cutContext(words, region("r1", ["this"]), new Set(["r0", "r1"]));
		expect(context.before.map((w) => [w.text, w.cut])).toEqual([
			["so", false],
			["um", true],
			["this", false],
		]);
		expect(context.head).toEqual(["this"]);
		expect(context.after.map((w) => w.text)).toEqual(["works"]);
	});

	it("shortens a long cut in the middle", () => {
		const removed = Array.from({ length: 40 }, (_, i) => `w${i}`);
		const words = removed.map((text) => word(text, "r"));
		const context = cutContext(words, region("r", removed), new Set(["r"]));
		expect(context.head).toHaveLength(12);
		expect(context.tail).toEqual(removed.slice(-6));
		expect(context.hidden).toBe(22);
		expect(context.all).toEqual(removed);
	});
});

import { describe, expect, it } from "vitest";
import type { DropMap } from "./decide";
import type { Clip } from "./edgeTrim";
import { cutRegions, dropRuns } from "./risk";
import { makeWords } from "./testSupport";

const text = "so here is the thing we want to say today and then a b c d e f g h i j".split(" ");
const words = makeWords([text]);
const clip = (from: number, to: number): Clip => ({
	take: words[0].take,
	start: words[from].S,
	end: words[to].E,
	first: words[from],
	last: words[to],
	joinsBefore: [],
	startKind: "",
	endKind: "",
	words: [],
});

describe("cut regions", () => {
	const drop: DropMap = new Map();
	for (let i = 5; i <= 12; i++) {
		drop.set(i, { kind: "retake", reason: "scratched", sources: ["model"], keep: [14] });
	}
	drop.set(16, { kind: "stutter", reason: "stutter", sources: ["rule"], keep: [17] });
	const order = new Map([[words[0].take.id, 0]]);
	const clips = [clip(0, 4), clip(13, 15), clip(17, 21)];

	it("groups consecutive words cut for the same reason", () => {
		expect(dropRuns(words, drop).map((r) => r.words.length)).toEqual([8, 1]);
	});

	it("flags a long cut decided by one model and absent from the kept words", () => {
		const [retake, stutter] = cutRegions(words, drop, clips, order, 8);
		expect(retake).toMatchObject({
			kind: "retake",
			firstWordIndex: 5,
			lastWordIndex: 12,
			risky: true,
			riskFlags: ["no-kept-repeat", "single-model"],
		});
		expect(retake.riskScore).toBeCloseTo(2 * Math.min(words[12].E - words[5].S, 15), 6);
		expect(retake.timelineSec).toBeCloseTo(clips[0].end - clips[0].start, 6);
		expect(stutter).toMatchObject({ kind: "stutter", risky: false, riskScore: 0, riskFlags: [] });
	});

	it("flags no more cuts than the limit", () => {
		expect(cutRegions(words, drop, clips, order, 0).some((r) => r.risky)).toBe(false);
	});

	it("gives no timeline position to a cut after the last clip", () => {
		const late: DropMap = new Map([
			[20, { kind: "retake", reason: "x", sources: ["model"], keep: [] }],
		]);
		const [region] = cutRegions(words, late, [clip(0, 18)], order, 8);
		expect(region.timelineSec).toBeNull();
	});
});

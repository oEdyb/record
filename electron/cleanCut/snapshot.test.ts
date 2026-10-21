import { expect, it } from "vitest";
import { readableReason, viewPlan } from "./snapshot";
import type { CleanCutPlan, CutRegion, KeptClip } from "./types";

const clip = (startSec: number, endSec: number): KeptClip => ({
	startSec,
	endSec,
	firstWordIndex: 0,
	lastWordIndex: 0,
	words: [],
	joinReasons: [],
	startKind: "",
	endKind: "",
});

const cut = (
	first: number,
	last: number,
	startSec: number,
	endSec: number,
	kind = "retake",
): CutRegion => ({
	takeId: "a",
	firstWordIndex: first,
	lastWordIndex: last,
	text: "so so",
	startSec,
	endSec,
	kind,
	reason: "Broken-off sentence, restated in U22",
	sources: ["rule", "model"],
	timelineSec: null,
	keptTimelineSec: null,
	risky: first === 3,
	riskScore: 0,
	riskFlags: [],
});

const plan = {
	takes: [{ takeId: "a", clips: [clip(0, 2), clip(5, 8)] }],
	cuts: [cut(1, 1, 2.2, 2.8, "stutter"), cut(3, 4, 3.5, 4.6, "hesitation")],
	dropped: [],
	stats: {},
	skipped: [],
} as unknown as CleanCutPlan;

const words = [0, 1, 2, 3, 4, 5].map((i) => ({
	word: `w${i}`,
	startSec: i,
	endSec: i + 0.5,
	confidence: 1,
}));

it("splits a shared gap between its cuts and shifts every time into the recording's source time", () => {
	const view = viewPlan(plan, [{ assetId: "a", offsetSec: 0.5, words }]);
	expect(view.keep).toEqual([
		{ assetId: "a", startSec: 0.5, endSec: 2.5 },
		{ assetId: "a", startSec: 5.5, endSec: 8.5 },
	]);
	expect(
		view.regions.map((r) => [r.id, r.kind, r.removedStartSec, r.removedEndSec, r.risky]),
	).toEqual([
		["a:1", "stutter", 2.5, 3.65, false],
		["a:3", "filler", 3.65, 5.5, true],
	]);
	expect(view.words.map((w) => w.regionId)).toEqual([null, "a:1", null, "a:3", "a:3", null]);
	expect(view.words[1]?.startSec).toBe(1.5);
});

it("drops internal sentence ids from reasons", () => {
	expect(readableReason("Broken-off sentence, restated in U22")).toBe(
		"Broken-off sentence, restated",
	);
	expect(readableReason("Fragment before U30")).toBe("Fragment");
	expect(readableReason("echo of the end of T01.U36")).toBe("echo of the end");
	expect(readableReason("scratched")).toBe("scratched");
});

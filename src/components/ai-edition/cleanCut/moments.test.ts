import { describe, expect, it } from "vitest";
import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import type { CleanCutKind } from "@/lib/cleanCut/types";
import { blockTarget, layoutCutBlocks } from "./cutBlocks";
import { buildCutRows } from "./cutRows";
import {
	groupMoments,
	momentsById,
	pauseCuts,
	removedSecOf,
	sharedKind,
	silenceSecOf,
	spokenSecByRegion,
} from "./moments";
import { playbackSpans, speechBins } from "./speechLevels";

const cut = (
	id: string,
	rawStartSec: number,
	rawEndSec: number,
	options: { kind?: CleanCutKind; risky?: boolean; restored?: boolean; words?: string[] } = {},
): ReviewCut => ({
	region: {
		id,
		kind: options.kind ?? "retake",
		assetId: "a",
		removedStartSec: rawStartSec,
		removedEndSec: rawEndSec,
		words: options.words ?? [id],
		reason: "",
		sources: ["rule"],
		risky: options.risky ?? false,
	},
	rawStartSec,
	rawEndSec,
	removedSec: rawEndSec - rawStartSec,
	restored: options.restored ?? false,
});

// The playback clock with every cut below lifted out: each one closes to its start.
const removed = (cuts: ReviewCut[]) => (rawSec: number) =>
	rawSec -
	cuts
		.filter((entry) => !entry.restored && entry.rawEndSec <= rawSec)
		.reduce((sum, entry) => sum + entry.removedSec, 0);

describe("groupMoments", () => {
	it("joins back-to-back retakes into one seam and keeps a distant cut apart", () => {
		const cuts = [
			cut("a", 240, 270, { risky: true }),
			cut("b", 270, 290),
			cut("c", 290, 300),
			cut("d", 400, 402, { kind: "stutter" }),
		];
		const moments = groupMoments(cuts, removed(cuts));
		expect(moments.map((m) => m.cuts.map((c) => c.region.id))).toEqual([["a", "b", "c"], ["d"]]);
		expect(moments[0]).toMatchObject({ atSec: 240, removedSec: 60, unsure: true });
		expect(sharedKind(moments[0])).toBe("retake");
		expect(momentsById(moments).get("c")).toBe(moments[0]);
	});

	it("keeps a group whole when a cut in it is restored, which then removes no time", () => {
		const cuts = [cut("a", 10, 20), cut("b", 20, 30, { restored: true }), cut("c", 30, 40)];
		const moments = groupMoments(cuts, removed(cuts));
		expect(moments.map((m) => m.cuts.map((c) => c.region.id))).toEqual([["a", "b", "c"]]);
		expect(moments[0].removedSec).toBe(20);
	});

	it("leaves pauses out: they are not word cuts", () => {
		const cuts = [cut("p", 5, 6, { kind: "pause" }), cut("w", 50, 51)];
		expect(groupMoments(cuts, (sec) => sec).map((m) => m.key)).toEqual(["w"]);
	});
});

describe("buildCutRows", () => {
	const cuts = [
		cut("a", 240, 270, { risky: true, words: ["now", "the", "skills"] }),
		cut("b", 270, 290, { words: ["skills", "again"] }),
		cut("c", 290, 291, { kind: "filler", words: ["um"] }),
	];
	const moments = groupMoments(cuts, removed(cuts));

	it("lists each moment once, with the same count and time, unsure moments first", () => {
		const sections = buildCutRows(moments, "", new Set());
		expect(
			sections.map((s) => [s.unsure, s.count, s.removedSec, s.rows.map((r) => r.key)]),
		).toEqual([[true, 1, 51, ["m:a"]]]);
		const [row] = sections[0].rows;
		expect(row.type === "moment" && row.moment.cuts.length).toBe(3);
	});

	it("opens a moment to show each of its cuts", () => {
		const [unsure] = buildCutRows(moments, "", new Set(["a"]));
		expect(unsure.rows.map((r) => r.key)).toEqual(["m:a", "c:a", "c:b", "c:c"]);
	});

	it("keeps moments with a matching cut, opened on the matches, figures whole", () => {
		const sections = buildCutRows(moments, "Again", new Set());
		expect(sections.flatMap((s) => s.rows.map((r) => r.key))).toEqual(["m:a", "c:b"]);
		expect(sections[0].removedSec).toBe(51);
		expect(buildCutRows(moments, "nothing like this", new Set())).toEqual([]);
	});

	it("puts sure moments in their own section", () => {
		const sure = [cut("x", 10, 12), cut("y", 500, 503, { risky: true })];
		const sections = buildCutRows(groupMoments(sure, removed(sure)), "", new Set());
		expect(sections.map((s) => [s.unsure, s.count, s.rows.map((r) => r.key)])).toEqual([
			[true, 1, ["c:y"]],
			[false, 1, ["c:x"]],
		]);
	});
});

describe("totals", () => {
	it("adds word moments and pauses up to everything removed", () => {
		const strip = [
			cut("p1", 0, 2, { kind: "pause" }),
			cut("a", 10, 14, { risky: true }),
			cut("p2", 20, 23, { kind: "pause", restored: true }),
			cut("b", 30, 31),
		];
		const moments = groupMoments(strip, (sec) => sec);
		const words = moments.reduce((sum, m) => sum + m.removedSec, 0);
		expect(words + removedSecOf(pauseCuts(strip))).toBe(removedSecOf(strip));
		expect(removedSecOf(strip)).toBe(7);
	});

	it("tells the silence inside a cut from its words", () => {
		const spoken = spokenSecByRegion([
			{ text: "This", assetId: "a", startSec: 1, endSec: 1.2, regionId: "s" },
			{ text: "so", assetId: "a", startSec: 9, endSec: 9.5, regionId: null },
		]);
		expect(silenceSecOf(cut("s", 0, 3.7), spoken)).toBeCloseTo(3.5);
		expect(silenceSecOf(cut("s", 0, 0.9), spoken)).toBe(0);
	});
});

describe("layoutCutBlocks", () => {
	const at = (id: string, sec: number, removedSec: number, risky = false) => {
		const [moment] = groupMoments([cut(id, sec, sec + removedSec, { risky })], () => sec);
		return moment;
	};

	it("sizes a block by the time it removes, centred on its seam, at least 3 px", () => {
		const blocks = layoutCutBlocks(
			[at("a", 100, 20), at("b", 500, 0.1)],
			(m) => m.atSec,
			1000,
			1000,
		);
		expect(blocks.map((b) => [b.left, b.right])).toEqual([
			[90, 110],
			[498.5, 501.5],
		]);
		expect(blockTarget(blocks[1])).toEqual({ left: 494, width: 12 });
	});

	it("never lets two blocks overlap", () => {
		const blocks = layoutCutBlocks(
			[at("a", 100, 30), at("b", 110, 30), at("c", 111, 0.1)],
			(m) => m.atSec,
			1000,
			1000,
		);
		for (let i = 1; i < blocks.length; i += 1) {
			expect(blocks[i].left).toBeGreaterThanOrEqual(blocks[i - 1].right + 1);
			expect(blocks[i].right - blocks[i].left).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("speech on the playback clock", () => {
	const clips = [
		{
			id: "clip",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		},
	] as unknown as Parameters<typeof playbackSpans>[1];
	const word = (text: string, startSec: number, regionId: string | null = null) => ({
		text,
		assetId: "a",
		startSec,
		endSec: startSec + 0.5,
		regionId,
	});

	it("drops words of an active cut and marks words of a restored one", () => {
		const words = [word("hello", 0), word("um", 1, "cut"), word("again", 2, "back"), word("x", 3)];
		const spans = playbackSpans(words, clips, new Set(["cut"]), new Set(["back"]), (sec) => sec);
		expect(spans.map((s) => [s.startSec, s.restored])).toEqual([
			[0, false],
			[2, true],
			[3, false],
		]);
		const bins = speechBins(spans, 4, 4);
		expect(bins.map((b) => b.restored)).toEqual([false, false, true, false]);
		expect(bins[1].level).toBeLessThan(bins[0].level);
	});
});

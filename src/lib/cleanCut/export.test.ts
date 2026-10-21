import { describe, expect, it } from "vitest";
import { cleanCutTimeline } from "../../../electron/export/cleanCutSpans";
import session from "../../../tests/fixtures/clean-cut-obs-session.json";
import { MAX_MARKER_TEXT, toCleanCut } from "./export";
import { snapshotFromFixture } from "./fixture";
import { keepDurationSec } from "./keep";
import type { CleanCutKeep, CleanCutRegion } from "./types";

const keep: CleanCutKeep[] = [
	{ assetId: "a", startSec: 1, endSec: 10 },
	{ assetId: "a", startSec: 12, endSec: 20 },
	{ assetId: "a", startSec: 25, endSec: 30 },
];

function region(id: string, start: number, end: number, extra: Partial<CleanCutRegion> = {}) {
	return {
		id,
		kind: "retake",
		assetId: "a",
		removedStartSec: start,
		removedEndSec: end,
		words: ["but", "okay"],
		reason: "Stumbled attempt",
		sources: ["model", "session"],
		risky: false,
		...extra,
	} satisfies CleanCutRegion;
}

const regions: CleanCutRegion[] = [
	region("head", 0, 1, { kind: "pause", words: [], reason: "Long pause" }),
	region("r1", 10, 12),
	region("r2a", 20, 22, { kind: "stutter", sources: ["rule"] }),
	region("r2b", 22, 25, { kind: "false-start" }),
	region("tail", 30, 31),
];

describe("toCleanCut", () => {
	it("puts one marker on the stretch after each word cut", () => {
		const cut = toCleanCut(keep, regions, "clean", new Set());
		expect(cut.keep).toEqual(keep);
		expect(cut.markers).toEqual([
			{
				keepIndex: 1,
				name: "Retake",
				comment: "Retake (Stumbled attempt): “but okay”",
				color: "ORANGE",
			},
			{
				keepIndex: 2,
				name: "Stutter + False start",
				comment:
					"Stutter (Stumbled attempt): “but okay” / False start (Stumbled attempt): “but okay”",
				color: "CYAN",
			},
		]);
	});

	it("drops the marker and joins the stretches for a restored cut", () => {
		const cut = toCleanCut(keep, regions, "clean", new Set(["r1"]));
		expect(cut.keep).toEqual([
			{ assetId: "a", startSec: 1, endSec: 20 },
			{ assetId: "a", startSec: 25, endSec: 30 },
		]);
		expect(cut.markers.map((m) => [m.keepIndex, m.name])).toEqual([[1, "Stutter + False start"]]);
	});

	it("Gentle exports only cuts two checks agree on", () => {
		const cut = toCleanCut(keep, regions, "gentle", new Set());
		expect(cut.markers.map((m) => m.name)).toEqual(["Retake", "False start"]);
	});

	it("lays out on the export side with a marker at each seam", () => {
		const cut = toCleanCut(keep, regions, "clean", new Set());
		const layout = cleanCutTimeline(
			[
				{
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 31,
					timelineStartSec: 0,
					timelineEndSec: 31,
				},
			],
			cut,
		);
		expect(layout.spans.map((s) => [s.timelineStartSec, s.timelineEndSec])).toEqual([
			[0, 9],
			[9, 17],
			[17, 22],
		]);
		expect(layout.markers.map((m) => m.timelineSec)).toEqual([9, 17]);
	});
});

describe("long marker notes", () => {
	it("keeps every note within what the save accepts, for a seam with many cuts", () => {
		const many = Array.from({ length: 12 }, (_, n) =>
			region(`m${n}`, 10 + n * 0.1, 10 + (n + 1) * 0.1, {
				words: "now the cloud.md file tells you how you work but wait".split(" "),
				reason: "The speaker restarted the sentence and tried again",
			}),
		);
		const cut = toCleanCut(keep, many, "clean", new Set());
		expect(cut.markers.length).toBeGreaterThan(0);
		for (const marker of cut.markers)
			expect(marker.comment.length).toBeLessThanOrEqual(MAX_MARKER_TEXT);
		expect(cut.markers[0]!.comment.endsWith("…")).toBe(true);
	});
});

describe("recorded OBS session", () => {
	const snapshot = snapshotFromFixture(session, "asset", "project");
	const wordCuts = snapshot.regions.filter((r) => r.kind !== "pause");

	it("cuts 24:00 down to 14:54 at Clean", () => {
		expect(Math.round(snapshot.rawDurationSec ?? 0)).toBe(1437);
		expect(Math.round(keepDurationSec(snapshot.keep))).toBe(894);
	});

	it("has 51 word cuts, a dozen unsure, and fewer at Gentle", () => {
		expect(wordCuts).toHaveLength(51);
		expect(wordCuts.filter((r) => r.risky)).toHaveLength(12);
		const gentle = toCleanCut(snapshot.keep, snapshot.regions, "gentle", new Set());
		expect(keepDurationSec(gentle.keep)).toBeGreaterThan(keepDurationSec(snapshot.keep));
	});

	it("restoring every cut keeps everything but the pauses", () => {
		const all = new Set(wordCuts.map((r) => r.id));
		const pauses = snapshot.regions
			.filter((r) => r.kind === "pause")
			.reduce((sum, r) => sum + (r.removedEndSec - r.removedStartSec), 0);
		const cut = toCleanCut(snapshot.keep, snapshot.regions, "clean", all);
		expect(cut.markers).toEqual([]);
		expect(keepDurationSec(cut.keep) + pauses).toBeCloseTo(snapshot.rawDurationSec ?? 0, 2);
	});

	it("tags every cut word with its region", () => {
		const tagged = snapshot.words.filter((w) => w.regionId !== null).length;
		expect(tagged).toBe(wordCuts.reduce((sum, r) => sum + r.words.length, 0));
	});
});

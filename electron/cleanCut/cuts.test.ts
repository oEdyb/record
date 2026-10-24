import { describe, expect, it } from "vitest";
import { analyse, FPS } from "./acoustics";
import { snapMin } from "./cutPoints";
import { type Clip, trimEdges } from "./edgeTrim";
import { planCleanCut } from "./engine";
import { makeTake, makeWords, type Spec, voicePcm } from "./testSupport";
import type { CleanCutTake } from "./types";

const onFrame = (t: number) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-6;

describe("frame snap", () => {
	const pcm = voicePcm(3, [
		[0.2, 1.0],
		[1.6, 2.4],
	]);
	const a = analyse(pcm);

	it("lands on a whole 1/60 s frame inside the range, at the quietest spot", () => {
		const t = snapMin(a, 1.07, 1.53, 1.3);
		expect(onFrame(t)).toBe(true);
		expect(t).toBeGreaterThanOrEqual(1.07);
		expect(t).toBeLessThanOrEqual(1.53);
		const quiet = a.smooth(5)[a.i(t)];
		expect(quiet).toBeLessThanOrEqual(a.smooth(5)[a.i(1.07)] + 1e-9);
	});

	it("falls back to the nearest frame when the range holds none", () => {
		const t = snapMin(a, 1.01, 1.012);
		expect(onFrame(t)).toBe(true);
	});

	it("stays out of the speech on either side of the pause", () => {
		const t = snapMin(a, 0.9, 1.7);
		expect(t).toBeGreaterThan(1.02);
		expect(t).toBeLessThan(1.6);
	});
});

describe("edge trim", () => {
	const pcm = voicePcm(5, [[1.0, 1.5]]);
	const acoustics = new Map([["t0", analyse(pcm)]]);
	const words = makeWords([[["hello", 0.8, 0.5]]]);
	const byTake = new Map([["t0", words]]);
	const clip = (start: number, end: number): Clip => ({
		take: words[0].take,
		start,
		end,
		first: words[0],
		last: words[0],
		joinsBefore: [],
		startKind: "",
		endKind: "",
		words: ["hello"],
	});

	it("cuts dead air from both ends down to the lead and tail around the voice", () => {
		const c = clip(0.2, 4.0);
		const saved = trimEdges([c], acoustics, byTake);
		expect(c.start).toBeGreaterThan(0.85);
		expect(c.start).toBeLessThanOrEqual(0.93);
		expect(c.end).toBeGreaterThan(1.6);
		expect(c.end).toBeLessThan(1.75);
		expect(onFrame(c.start) && onFrame(c.end)).toBe(true);
		expect(saved).toBeCloseTo(c.start - 0.2 + (4.0 - c.end), 6);
	});

	it("never extends a clip that is already tight", () => {
		const c = clip(0.97, 1.55);
		trimEdges([c], acoustics, byTake);
		expect(c.start).toBeGreaterThanOrEqual(0.97);
		expect(c.end).toBeLessThanOrEqual(1.55);
	});
});

describe("cut placement", () => {
	const specs: Spec[] = [
		["we", 0.4, 0.3],
		["the", 0.3, 0.3],
		["the", 0.3, 0.3],
		["plan", 0.3, 0.4],
		["works", 0.3, 0.5],
	];

	function take(): CleanCutTake {
		const t = makeTake("t0", specs, 0);
		const bursts = t.words.map((w): [number, number] => [w.startSec, w.endSec]);
		return { ...t, pcm: voicePcm(4.5, bursts) };
	}

	it("puts each cut in silence, on a frame, before the next word, and drops the first stutter copy", async () => {
		const t = take();
		const plan = await planCleanCut({ takes: [t] });
		expect(plan.dropped.map((d) => [d.word, d.kind])).toEqual([["the", "stutter"]]);
		expect(plan.dropped[0].startSec).toBeCloseTo(t.words[1].startSec, 1);
		const [first, second] = plan.takes[0].clips;
		expect(plan.takes[0].clips).toHaveLength(2);
		expect(first.words).toEqual(["we"]);
		expect(second.words).toEqual(["the", "plan", "works"]);
		expect(first.endSec).toBeGreaterThan(t.words[0].endSec);
		expect(first.endSec).toBeLessThan(t.words[1].startSec);
		expect(second.startSec).toBeGreaterThan(t.words[1].endSec);
		expect(second.startSec).toBeLessThan(t.words[2].startSec);
		for (const c of [first, second]) expect(onFrame(c.startSec) && onFrame(c.endSec)).toBe(true);
		expect(plan.stats.joins).toBe(1);
		expect(plan.cuts).toHaveLength(1);
		expect(plan.cuts[0].timelineSec).not.toBeNull();
	});

	it("falls back to rules and reports it when the model fails", async () => {
		const plan = await planCleanCut({
			takes: [take()],
			model: {
				ask: async () => {
					throw new Error("offline");
				},
			},
		});
		expect(plan.skipped).toEqual([
			"word-level model call: offline",
			"whole-session model pass: offline",
		]);
		expect(plan.dropped).toHaveLength(1);
	});
});

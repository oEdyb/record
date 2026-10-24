import { describe, expect, it } from "vitest";
import { fillers } from "./fillers";
import { restarts } from "./restarts";
import { retakes } from "./retakes";
import { sameWord } from "./similar";
import { makeWords } from "./testSupport";

describe("fillers", () => {
	const words = makeWords([["so", "um", ["we", 0.6], "go", ["uh", 0.02], "on"]]);

	it("cuts a filler next to a pause and leaves one glued into speech", () => {
		const out = fillers(words, "paused");
		expect(out.map((c) => c.drop)).toEqual([[1]]);
		expect(out[0].why).toBe("filler 'um'");
	});

	it("cuts every filler with the all policy and none with the none policy", () => {
		expect(fillers(words, "all").map((c) => c.drop)).toEqual([[1], [4]]);
		expect(fillers(words, "none")).toEqual([]);
	});
});

describe("stutters", () => {
	it("keeps the second copy of a repeated function word", () => {
		const words = makeWords([["we", ["the", 0.05], ["the", 0.1], "plan", "works"]]);
		const [c] = restarts(words);
		expect(c.kind).toBe("stutter");
		expect(c.confidence).toBe("high");
		expect(c.drop).toEqual([1]);
		expect(c.keep).toEqual([2]);
	});

	it("keeps the first copy when the gap is under 0.25 s and the second is under 0.6x as long", () => {
		const words = makeWords([["we", ["the", 0.05, 0.4], ["the", 0.1, 0.2], "plan"]]);
		const [c] = restarts(words);
		expect(c.drop).toEqual([2]);
		expect(c.keep).toEqual([1]);
	});

	it("keeps the second copy at a 0.25 s gap even when it is short", () => {
		const words = makeWords([["we", ["the", 0.05, 0.4], ["the", 0.25, 0.1], "plan"]]);
		const [c] = restarts(words);
		expect(c.drop).toEqual([1]);
		expect(c.keep).toEqual([2]);
	});

	it("keeps the second copy when it is 0.6x as long or longer", () => {
		const words = makeWords([["we", ["the", 0.05, 0.4], ["the", 0.1, 0.24], "plan"]]);
		const [c] = restarts(words);
		expect(c.drop).toEqual([1]);
	});

	it("leaves emphasis words alone and sends a repeated content word to the model", () => {
		expect(restarts(makeWords([["it", "is", "very", "very", "good"]]))).toEqual([]);
		const [c] = restarts(makeWords([["we", "build", "robots", "robots", "today"]]));
		expect(c.confidence).toBe("ambiguous");
	});
});

describe("restarts", () => {
	it("drops the earlier attempt of a phrase said again after a hesitation", () => {
		const words = makeWords([
			["so", "this", "is", "the", ["um", 0.3], "this", "is", "the", "plan"],
		]);
		const cands = restarts(words);
		const repair = cands.find((c) => c.kind === "repair");
		expect(repair?.confidence).toBe("high");
		expect(repair?.drop.map((i) => words[i].text)).toEqual(["this", "is", "the"]);
	});
});

describe("retakes", () => {
	const line = ["we", "record", "the", "screen", "then", "we", "cut", "it", "down", "fast."];

	it("keeps the last attempt and drops the earlier one", () => {
		const words = makeWords([[...line], ["okay", ["so", 0.9], ...line.slice(0, 9), "fast."]]);
		const [c] = retakes(words);
		expect(c.kind).toBe("retake");
		expect(c.drop.map((i) => words[i].text)).toEqual(line);
		expect(c.keep.every((i) => words[i].take === words[words.length - 1].take)).toBe(true);
	});

	it("keeps the earlier attempt when the later one is cut short", () => {
		const first = [
			"we",
			"record",
			"the",
			"screen",
			"then",
			"we",
			"cut",
			"it",
			"down",
			"fast.",
			"and",
			"ship",
		];
		const short = ["we", "record", "the", "screen", "then", "we"];
		const words = makeWords([first, short]);
		const [c] = retakes(words);
		expect(c.why).toContain("later attempt is cut short");
		expect(c.drop.map((i) => words[i].take.id)).toEqual(Array(c.drop.length).fill("t1"));
	});
});

describe("sameWord", () => {
	it("matches near spellings of long words the way difflib does", () => {
		const [a, b, c] = makeWords([["bigram", "biogram", "trigrams"]]);
		expect(sameWord(a, b)).toBe(true);
		expect(sameWord(a, c)).toBe(false);
	});
});

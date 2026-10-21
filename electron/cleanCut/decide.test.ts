import { describe, expect, it } from "vitest";
import type { Candidate } from "./candidates";
import { decide, sessionText, wordsPrompt } from "./decide";
import { parseJsonObject } from "./modelJson";
import { WORDS_PROMPT } from "./prompts";
import { mergeSession, sessionDrops, sessionPrompt } from "./session";
import { makeTake, makeWords } from "./testSupport";
import type { DecisionModel } from "./types";
import { splitUnits } from "./units";
import { unitWords } from "./words";

const cand = (drop: number[], confidence: "high" | "ambiguous", kind = "repair"): Candidate => ({
	kind: kind as Candidate["kind"],
	drop,
	keep: [],
	confidence,
	why: "test",
	id: "",
	evidence: 0,
});

const replying = (reply: string): DecisionModel & { prompts: string[] } => {
	const prompts: string[] = [];
	return { prompts, ask: async (prompt) => (prompts.push(prompt), reply) };
};

describe("parseJsonObject", () => {
	it("finds the first object inside prose and a code fence", () => {
		const text =
			'Sure.\n```json\n{"drop": [{"ids": ["T01.U02"], "reason": "a } b"}]}\n```\nDone {"x": 1}';
		expect(parseJsonObject(text)).toEqual({ drop: [{ ids: ["T01.U02"], reason: "a } b" }] });
	});

	it("throws when there is no object", () => {
		expect(() => parseJsonObject("no json here")).toThrow(/No JSON/);
	});
});

describe("word-level decision", () => {
	const words = makeWords([
		["we", "went", "to", "the", "the", "shop.", ["and", 1.0], "then", "left."],
	]);

	it("keeps rule drops, applies the model's candidate and unit choices, and records sources", async () => {
		const cands = [cand([3], "high", "stutter"), cand([1, 2], "ambiguous")];
		const model = replying(
			'{"cut_candidates": ["C2"], "drop_units": [{"ids": ["T01.U02"], "kind": "tangent", "reason": "off track"}]}',
		);
		const { drop } = await decide(words, cands, model);
		expect(drop.get(3)?.sources).toEqual(["rule"]);
		expect(drop.get(1)?.sources).toEqual(["rule", "model"]);
		expect(drop.get(6)).toMatchObject({ kind: "tangent", reason: "off track", sources: ["model"] });
		expect(drop.has(0)).toBe(false);
		expect(model.prompts[0]).toBe(wordsPrompt(words, [cands[1]], new Set([3])));
	});

	it("without a model only the high-confidence rules cut", async () => {
		const { drop } = await decide(words, [cand([3], "high"), cand([1], "ambiguous")], null);
		expect([...drop.keys()]).toEqual([3]);
	});

	it("marks cut words with double brackets in the session text", () => {
		const { text, units } = sessionText(words, new Set([3, 4]));
		expect(text).toContain("we went to [[the the]] shop.");
		expect(text).toContain("[T01.U02");
		expect(units.get("T01.U01")).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("fills the prompt template without touching the rest", () => {
		const prompt = wordsPrompt(words, [], new Set());
		expect(prompt.startsWith(WORDS_PROMPT.slice(0, 200))).toBe(true);
		expect(prompt).toContain("CANDIDATES\n(none)\n\nSESSION\n");
	});
});

describe("whole-session pass", () => {
	const take = makeTake("a", ["one.", "two.", "three."], new Date(2026, 9, 20, 14, 5).getTime());
	const units = splitUnits([take]);

	it("lists every unit with a take header and parses the drops", async () => {
		const model = replying(
			'{"drop": [{"ids": ["T01.U02", "T09.U01"], "kind": "retake", "reason": "again"}]}',
		);
		const drops = await sessionDrops(units, model);
		expect(model.prompts[0]).toBe(sessionPrompt(units));
		expect(model.prompts[0]).toContain("== T01 (a) recorded 2026-10-20 14:05 ==");
		expect(drops).toEqual([{ ids: ["T01.U02"], kind: "retake", reason: "again" }]);
	});

	it("merges into the word drops: new words come from the session, shared words gain a source", () => {
		const words = makeWords([["one.", "two.", "three."]]);
		const drop = new Map([
			[1, { kind: "stutter", reason: "r", sources: ["rule" as const], keep: [] }],
		]);
		const added = mergeSession(
			unitWords(words),
			splitUnits([words[0].take]),
			[{ ids: ["T01.U02", "T01.U03"], kind: "retake", reason: "x" }],
			drop,
		);
		expect(added).toBe(1);
		expect(drop.get(1)?.sources).toEqual(["rule", "session"]);
		expect(drop.get(2)).toMatchObject({ kind: "retake", sources: ["session"] });
	});

	it("rejects a reply without a drop list", async () => {
		await expect(sessionDrops(units, replying('{"nope": []}'))).rejects.toThrow(/no drop list/);
	});
});

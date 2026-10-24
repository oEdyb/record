import type { Candidate } from "./candidates";
import { parseJsonObject } from "./modelJson";
import { WORDS_PROMPT } from "./prompts";
import { clockTime, firstChars, fixed, pad } from "./pyCompat";
import type { DecisionModel, DecisionSource } from "./types";
import type { Word } from "./words";

/** Why a word is cut. More than one source means independent passes agreed. */
export interface Why {
	kind: string;
	reason: string;
	sources: DecisionSource[];
	keep: number[];
}

export type DropMap = Map<number, Why>;

export interface Decision {
	drop: DropMap;
	candidates: Candidate[];
	reply: Record<string, unknown> | null;
}

export function sameWhy(a: Why, b: Why): boolean {
	return (
		a.kind === b.kind &&
		a.reason === b.reason &&
		a.sources.join() === b.sources.join() &&
		a.keep.join() === b.keep.join()
	);
}

function mark(words: Word[], drop: Set<number>): string {
	const out: string[] = [];
	let open = false;
	for (const w of words) {
		if (drop.has(w.gi) && !open) {
			out.push("[[");
			open = true;
		}
		if (!drop.has(w.gi) && open) {
			out[out.length - 1] += "]]";
			open = false;
		}
		out.push(w.text);
	}
	if (open) out[out.length - 1] += "]]";
	return out.join(" ").split("[[ ").join("[[").split(" ]]").join("]]");
}

export function sessionText(
	words: Word[],
	ruleDrop: Set<number>,
): { text: string; units: Map<string, number[]> } {
	const units = new Map<string, number[]>();
	const lines: string[] = [];
	const takeIds = new Map<number, number>();
	for (const w of words) if (!takeIds.has(w.takeRank)) takeIds.set(w.takeRank, takeIds.size + 1);
	const unitOrd = new Map<number, number>();
	const count = new Map<number, number>();
	const byUnit = new Map<number, Word[]>();
	for (const w of words) {
		if (!unitOrd.has(w.unit)) {
			count.set(w.takeRank, (count.get(w.takeRank) ?? 0) + 1);
			unitOrd.set(w.unit, count.get(w.takeRank) as number);
		}
		byUnit.set(w.unit, [...(byUnit.get(w.unit) ?? []), w]);
	}
	let lastTake: Word["take"] | null = null;
	for (const ws of byUnit.values()) {
		const first = ws[0];
		const takeId = takeIds.get(first.takeRank) as number;
		if (first.take !== lastTake) {
			lines.push(
				`== T${pad(takeId)} (${firstChars(first.take.folder, 12)}/${first.take.key}, recorded ${clockTime(first.take.recordedAtMs)}) ==`,
			);
			lastTake = first.take;
		}
		const uid = `T${pad(takeId)}.U${pad(unitOrd.get(first.unit) as number)}`;
		units.set(
			uid,
			ws.map((w) => w.gi),
		);
		if (ws.every((w) => ruleDrop.has(w.gi))) continue;
		const before = first.ti ? words[first.gi - 1] : null;
		const gap = before ? Math.max(0, first.S - before.E) : 0;
		lines.push(
			`[${uid} ${fixed(first.S, 1)}-${fixed(ws[ws.length - 1].E, 1)}s gap ${fixed(gap, 1)}s] ${mark(ws, ruleDrop)}`,
		);
	}
	return { text: lines.join("\n"), units };
}

function candidateText(words: Word[], cands: Candidate[]): string {
	const lines = cands.map((c) => {
		const first = c.drop[0];
		const last = c.drop[c.drop.length - 1];
		const before = words
			.slice(Math.max(0, first - 8), first)
			.filter((w) => w.take === words[first].take)
			.map((w) => w.text)
			.join(" ");
		const after = words
			.slice(last + 1, last + 14)
			.filter((w) => w.take === words[last].take)
			.map((w) => w.text)
			.join(" ");
		const cut = c.drop.map((i) => words[i].text).join(" ");
		return `${c.id} (${c.kind}) ...${before} [[CUT: ${cut}]] KEEP: ${after}`;
	});
	return lines.join("\n") || "(none)";
}

export function wordsPrompt(words: Word[], ambiguous: Candidate[], ruleDrop: Set<number>): string {
	const values: Record<string, string> = {
		cands: candidateText(words, ambiguous),
		session: sessionText(words, ruleDrop).text,
	};
	return WORDS_PROMPT.replace(/%\((\w+)\)s/g, (_, name: string) => values[name]);
}

export async function decide(
	words: Word[],
	cands: Candidate[],
	model: DecisionModel | null,
): Promise<Decision> {
	cands.forEach((c, n) => {
		c.id = `C${n + 1}`;
	});
	const drop: DropMap = new Map();
	const set = (i: number, why: Why) => {
		if (!drop.has(i)) drop.set(i, why);
	};
	for (const c of cands) {
		if (c.confidence !== "high") continue;
		for (const i of c.drop)
			set(i, { kind: c.kind, reason: c.why, sources: ["rule"], keep: c.keep });
	}
	const ambiguous = cands.filter((c) => c.confidence !== "high");
	const { units } = sessionText(words, new Set(drop.keys()));
	let reply: Record<string, unknown> | null = null;
	if (model) {
		const prompt = wordsPrompt(words, ambiguous, new Set(drop.keys()));
		reply = parseJsonObject(await model.ask(prompt, "words"));
	}
	const cutIds = new Set(asStrings(reply?.cut_candidates));
	for (const c of ambiguous) {
		if (!cutIds.has(c.id)) continue;
		for (const i of c.drop)
			set(i, { kind: c.kind, reason: c.why, sources: ["rule", "model"], keep: c.keep });
	}
	for (const d of asObjects(reply?.drop_units)) {
		for (const u of asStrings(d.ids)) {
			for (const i of units.get(u) ?? []) {
				set(i, {
					kind: typeof d.kind === "string" ? d.kind : "unit",
					reason: typeof d.reason === "string" ? d.reason : "",
					sources: ["model"],
					keep: [],
				});
			}
		}
	}
	return { drop, candidates: cands, reply };
}

export function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function asObjects(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value)
		? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
		: [];
}

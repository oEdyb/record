import type { RefinedWord } from "./refineWords";
import type { CleanCutTake, WordTime } from "./types";
import type { Unit } from "./units";

export const FILLERS = new Set(
	"um uh uhm umm uhh er erm err hmm hm mm mmm mhm ah eh uhhh".split(" "),
);
const UNIT_PAUSE = 0.8;

export function norm(word: string): string {
	return word
		.toLowerCase()
		.replace(/’/g, "'")
		.replace(/[^a-z0-9']/g, "");
}

export interface Word {
	gi: number;
	take: CleanCutTake;
	ti: number;
	text: string;
	n: string;
	/** Recognizer start and end. */
	s: number;
	e: number;
	/** Acoustic start and end. */
	S: number;
	E: number;
	gapBefore: number;
	joinedBefore: boolean;
	unit: number;
	takeRank: number;
	pauseAfter: number;
}

export const isFiller = (w: Word) => FILLERS.has(w.n);
export const isTerminal = (w: Word) => /[.?!]$/.test(w.text.replace(/["')\]]+$/, ""));
export const isComma = (w: Word) => /[,;:—-]$/.test(w.text.trimEnd());

/** Takes in the order they were recorded. Within one folder the key is the order. */
export function recordingOrder(takes: CleanCutTake[]): CleanCutTake[] {
	const byFolder = new Map<string, CleanCutTake[]>();
	for (const take of takes) byFolder.set(take.folder, [...(byFolder.get(take.folder) ?? []), take]);
	const median = (ts: CleanCutTake[]) => {
		const v = ts.map((t) => t.recordedAtMs).sort((x, y) => x - y);
		const mid = Math.floor(v.length / 2);
		return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
	};
	return [...byFolder.values()]
		.sort((a, b) => median(a) - median(b))
		.flatMap((ts) => [...ts].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
}

export function buildWords(
	takes: CleanCutTake[],
	times: Map<string, WordTime[]>,
	refined: Map<string, RefinedWord[]>,
): Word[] {
	const words: Word[] = [];
	let unit = -1;
	recordingOrder(takes).forEach((take, rank) => {
		const spoken = take.words;
		const t = times.get(take.id) as WordTime[];
		const rf = refined.get(take.id) as RefinedWord[];
		let prev: Word | null = null;
		spoken.forEach((w, ti) => {
			const r = rf[ti];
			if (prev === null || isTerminal(prev) || r.S - prev.E > UNIT_PAUSE) unit += 1;
			const word: Word = {
				gi: words.length,
				take,
				ti,
				text: w.word,
				n: norm(w.word),
				s: t[ti].startSec,
				e: t[ti].endSec,
				S: r.S,
				E: r.E,
				gapBefore: r.gapBefore,
				joinedBefore: r.joinedBefore,
				unit,
				takeRank: rank,
				pauseAfter: 0,
			};
			if (prev) prev.pauseAfter = Math.max(0, word.S - prev.E);
			words.push(word);
			prev = word;
		});
	});
	return words;
}

/** Unit -> global indices of its words. */
export function unitWords(words: Word[]): (unit: Unit) => number[] {
	const index = new Map<string, number>();
	for (const w of words) index.set(`${w.take.id}\u0000${w.ti}`, w.gi);
	return (unit) => {
		const out: number[] = [];
		for (let ti = unit.first; ti <= unit.last; ti++)
			out.push(index.get(`${unit.take.id}\u0000${ti}`) as number);
		return out;
	};
}

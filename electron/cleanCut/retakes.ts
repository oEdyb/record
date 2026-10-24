import { type Candidate, spanText } from "./candidates";
import { sameWord } from "./similar";
import { isFiller, isTerminal, type Word } from "./words";

const MAX_REPARANDUM = 14;
const FAR_WINDOW = 1500;
const MIN_FAR_RUN = 6;
const LEAD_TRAIL = 4;

type Run = [number[], number[]];

function alignedRuns(toks: Word[]): Run[] {
	const index = new Map<string, number[]>();
	const key = (k: number) => `${toks[k].n} ${toks[k + 1].n} ${toks[k + 2].n}`;
	for (let k = 0; k < toks.length - 2; k++) index.set(key(k), [...(index.get(key(k)) ?? []), k]);
	const eq = (a: number, b: number) => sameWord(toks[a], toks[b]);
	const runs: Run[] = [];
	const seenStart = new Set<string>();
	for (let j = 0; j < toks.length - 2; j++) {
		for (const i of index.get(key(j)) ?? []) {
			if (i >= j || j - i > FAR_WINDOW) continue;
			if (toks[i].take === toks[j].take && j - i <= MAX_REPARANDUM) continue;
			if (i > 0 && j > 0 && eq(i - 1, j - 1) && seenStart.has(`${i - 1},${j - 1}`)) continue;
			let a = i;
			let b = j;
			let skips = 0;
			const pa: number[] = [];
			const pb: number[] = [];
			while (a < j && b < toks.length) {
				if (eq(a, b)) {
					pa.push(a);
					pb.push(b);
					a += 1;
					b += 1;
				} else if (skips < 2 && a + 1 < j && eq(a + 1, b)) {
					a += 1;
					skips += 1;
				} else if (skips < 2 && b + 1 < toks.length && eq(a, b + 1)) {
					b += 1;
					skips += 1;
				} else break;
			}
			if (pa.length >= MIN_FAR_RUN) {
				seenStart.add(`${i},${j}`);
				runs.push([pa, pb]);
			}
		}
	}
	return runs;
}

/**
 * Repeated phrases that sit farther apart than an in-sentence repair, in the same take or an
 * earlier one. The earlier attempt is dropped, widened to its unit, unless the later one is cut short.
 */
export function retakes(words: Word[]): Candidate[] {
	const toks = words.filter((w) => !isFiller(w));
	const unitWords = new Map<number, number[]>();
	toks.forEach((w, k) => unitWords.set(w.unit, [...(unitWords.get(w.unit) ?? []), k]));
	const unitOf = (k: number) => unitWords.get(toks[k].unit) as number[];

	const out: Candidate[] = [];
	const taken = new Set<number>();
	const ordered = alignedRuns(toks)
		.map((r, order) => ({ r, order }))
		.sort((x, y) => y.r[0].length - x.r[0].length || x.order - y.order);
	for (const {
		r: [pa, pb],
	} of ordered) {
		if (pa.some((k) => taken.has(k))) continue;
		const ea = pa[0];
		const eb = pa[pa.length - 1];
		const la = pb[0];
		const lb = pb[pb.length - 1];
		const earlierUnit = unitOf(ea);
		const laterUnit = unitOf(la);
		const earlierLastUnit = unitOf(eb);
		const laterLastUnit = unitOf(lb);
		const startsUnit =
			la === laterUnit[0] || toks[la].gapBefore >= 0.25 || toks[la].takeRank !== toks[ea].takeRank;
		const earlierStarts = ea === earlierUnit[0] || toks[ea].gapBefore >= 0.25;
		if (pa.length < 10 && !(startsUnit && earlierStarts)) continue;
		let earlierLength = 0;
		for (let u = toks[ea].unit; u <= toks[eb].unit; u++)
			earlierLength += unitWords.get(u)?.length ?? 0;
		const laterLengthAfter = laterLastUnit[laterLastUnit.length - 1] - la + 1;
		const laterLast = toks[laterLastUnit[laterLastUnit.length - 1]];
		const laterCutShort =
			!isTerminal(laterLast) &&
			laterLengthAfter < 0.7 * earlierLength &&
			isTerminal(toks[earlierUnit[earlierUnit.length - 1]]) &&
			pb.length < 0.7 * earlierLength;
		let keepIdx: number[];
		let why: string;
		let firstUnit: number[];
		let lastUnit: number[];
		let ds: number;
		let de: number;
		if (laterCutShort) {
			keepIdx = pa;
			why = "later attempt is cut short, earlier one kept";
			[firstUnit, lastUnit, ds, de] = [laterUnit, laterLastUnit, la, lb];
		} else {
			keepIdx = pb;
			why = "earlier attempt superseded by the later retake";
			[firstUnit, lastUnit, ds, de] = [earlierUnit, earlierLastUnit, ea, eb];
		}
		let dsK = ds;
		let deK = de;
		if (ds - firstUnit[0] <= LEAD_TRAIL) dsK = firstUnit[0];
		if (lastUnit[lastUnit.length - 1] - de <= LEAD_TRAIL) deK = lastUnit[lastUnit.length - 1];
		const dropSpan: number[] = [];
		for (let k = dsK; k <= deK; k++) dropSpan.push(k);
		for (const k of pa) taken.add(k);
		out.push({
			kind: "retake",
			drop: dropSpan.map((k) => toks[k].gi),
			keep: keepIdx.map((k) => toks[k].gi),
			confidence: pa.length >= 8 ? "high" : "ambiguous",
			why: `${why}: '${spanText(pa.slice(0, 10).map((k) => toks[k]))}...' (${pa.length} words repeated)`,
			id: "",
			evidence: 0,
		});
	}
	return out;
}

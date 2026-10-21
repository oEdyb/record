import { type Candidate, contentByTake, spanText } from "./candidates";
import { sameWord } from "./similar";
import { isComma, isFiller, isTerminal, type Word } from "./words";

const MAX_REPARANDUM = 14;

const FUNCTION = new Set(
	`the a an to of in on at for and or but so it its it's is are was were be we we're we've we'd we'll you
you're you've i i'm i've i'd i'll that that's this these those if as with they they're he she what how then just not
do does did have has had can will would could should there there's here from by than because when which who`.split(
		/\s+/,
	),
);
const EMPHASIS = new Set(
	"very really no yes okay ok super much long big hard more bad good many well so now".split(" "),
);
const SPELLED = /^[a-z0-9]$/;

interface Best {
	score: number;
	L: number;
	m: number;
	full: boolean;
	gap: number;
}

function bestOverlap(toks: Word[], j: number): Best | null {
	let best: Best | null = null;
	for (let L = 1; L <= Math.min(MAX_REPARANDUM, j); L++) {
		const i = j - L;
		const R = toks.slice(i, j);
		let m = 0;
		while (m < L && j + m < toks.length && sameWord(toks[i + m], toks[j + m])) m++;
		if (m === 0) continue;
		if (R.every((w) => SPELLED.test(w.n) && w.n !== "a" && w.n !== "i")) continue;
		if (R.slice(0, -1).some(isTerminal)) continue;
		const full = m >= L;
		const gap = Math.max(0, toks[j].S - R[R.length - 1].E);
		if (gap > 1.6) continue;
		if (!full && !(m >= 3 && m >= 0.5 * L)) continue;
		if (!full && isTerminal(R[R.length - 1])) continue;
		const score = (full ? 100 : 0) + m - 0.1 * L;
		if (best === null || score > best.score) best = { score, L, m, full, gap };
	}
	return best;
}

/**
 * Stutters and in-sentence repairs: an earlier attempt immediately followed by a later attempt that
 * starts the same way. Only the earlier attempt is dropped, except for a tight stutter whose
 * second copy is clipped short.
 */
export function restarts(words: Word[]): Candidate[] {
	const out: Candidate[] = [];
	for (const toks of contentByTake(words)) {
		let j = 1;
		while (j < toks.length) {
			const best = bestOverlap(toks, j);
			if (!best) {
				j += 1;
				continue;
			}
			const { L, m, full, gap } = best;
			const i = j - L;
			const R = toks.slice(i, j);
			let keep = toks.slice(j, j + Math.max(m, 1));
			const hesitation =
				words.slice(R[R.length - 1].gi + 1, toks[j].gi).some(isFiller) || gap >= 0.25;
			let conf: "high" | "ambiguous";
			let why: string;
			if (full && L === 1) {
				const w = R[0];
				if (FUNCTION.has(w.n) && !isComma(w) && gap <= 0.6) {
					conf = "high";
					why = `stutter '${w.n} ${w.n}'`;
				} else if (EMPHASIS.has(w.n) || /^[0-9]+$/.test(w.n) || isComma(w)) {
					j += 1;
					continue;
				} else {
					conf = "ambiguous";
					why = `repeated word '${w.n}' (content word, may be emphasis)`;
				}
			} else if (full) {
				conf = hesitation && L <= 8 ? "high" : "ambiguous";
				why = `restart: '${spanText(R)}' said again as '${spanText(keep)}'`;
			} else {
				const ev =
					Number(hesitation) + Number(!isComma(R[R.length - 1])) + Number(!toks[j].joinedBefore);
				conf = ev >= 3 && m >= 4 ? "high" : "ambiguous";
				why = `false start: '${spanText(R)}' redone as '${spanText(toks.slice(j, j + L + 2))}'`;
			}
			if (full && L >= 2 && j + L < toks.length && sameWord(toks[j + L], R[0])) {
				conf = "ambiguous";
				why += " (phrase keeps coming back: may be deliberate)";
			}
			const previous = out[out.length - 1];
			if (
				full &&
				L >= 2 &&
				previous &&
				previous.kind === "repair" &&
				previous.keep.includes(R[0].gi)
			) {
				conf = "ambiguous";
			}
			let dropWords = R;
			if (L === 1 && full) {
				const first = R[0];
				const second = toks[j];
				if (gap < 0.25 && second.E - second.S < 0.6 * (first.E - first.S)) {
					dropWords = [second];
					keep = [first];
				} else {
					dropWords = [first];
					keep = [second];
				}
			}
			out.push({
				kind: L === 1 && full ? "stutter" : "repair",
				drop: dropWords.map((w) => w.gi),
				keep: keep.map((w) => w.gi),
				confidence: conf,
				why,
				id: "",
				evidence: Number(hesitation),
			});
			j += L === 1 ? 1 : Math.max(1, m);
		}
	}
	return out;
}

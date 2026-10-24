import { type Acoustics, FRAME, SR } from "./acoustics";
import { runs } from "./runs";
import type { HesitationVetter, WordTime } from "./types";

const MIN_LEN = 0.25;
const MIN_DB_UNDER_LOUD = 30.0;
const MARGIN = 0.08;

const FILLER_READINGS = new Set([
	"",
	"um",
	"uh",
	"mm",
	"mmhmm",
	"uhhuh",
	"hmm",
	"ah",
	"oh",
	"yeah",
	"yes",
	"okay",
	"ok",
	"thankyou",
	"you",
	"bye",
	"ha",
	"haha",
	"huh",
	"eh",
	"er",
	"uhm",
	"mhm",
	"so",
	"and",
	"the",
	"a",
]);

export type TimeSpan = [number, number];

/** Voiced sounds the recognizer did not write down: activity that no word overlaps and that is clearly above room tone. */
export function hesitationCandidates(a: Acoustics, words: WordTime[]): TimeSpan[] {
	const covered = new Uint8Array(a.n);
	for (const w of words) {
		const to = a.i(w.endSec + MARGIN);
		for (let i = a.i(w.startSec - MARGIN); i <= to; i++) covered[i] = 1;
	}
	const free = new Uint8Array(a.n);
	for (let i = 0; i < a.n; i++) free[i] = a.active[i] && !covered[i] ? 1 : 0;
	const out: TimeSpan[] = [];
	for (const [s, e] of runs(free)) {
		if ((e - s) * FRAME < MIN_LEN) continue;
		let sum = 0;
		for (let i = s; i < e; i++) sum += a.db[i];
		if (sum / (e - s) < a.loud - MIN_DB_UNDER_LOUD) continue;
		out.push([a.t(s) - FRAME / 2, a.t(e) - FRAME / 2]);
	}
	return out;
}

export function isHesitationReading(words: string[]): boolean {
	return FILLER_READINGS.has(
		words
			.join("")
			.toLowerCase()
			.replace(/[^a-z]/g, ""),
	);
}

/** Keeps a candidate only when its isolated window reads as a filler or as nothing. */
export async function vetHesitations(
	a: Acoustics,
	candidates: TimeSpan[],
	vetter: HesitationVetter,
): Promise<TimeSpan[]> {
	const kept: TimeSpan[] = [];
	for (const [s, e] of candidates) {
		const from = Math.trunc(Math.max(0, s - 0.05) * SR);
		const to = Math.trunc((e + 0.05) * SR);
		const reading = await vetter.read(a.pcm.subarray(from, to));
		if (isHesitationReading(reading)) kept.push([s, e]);
	}
	return kept;
}

import { type Acoustics, FRAME } from "./acoustics";
import { argmin, runs } from "./runs";
import type { WordTime } from "./types";

export interface RefinedWord {
	S: number;
	E: number;
	gapBefore: number;
	joinedBefore: boolean;
}

/**
 * Per-word acoustic extents found from the silent plateau, or the energy valley when speech
 * runs on, between neighbouring recognizer words. Recognizer times only say where to look.
 */
export function refineWords(a: Acoustics, words: WordTime[]): RefinedWord[] {
	const n = words.length;
	const out: RefinedWord[] = words.map((w) => ({
		S: w.startSec,
		E: w.endSec,
		gapBefore: 0,
		joinedBefore: false,
	}));
	if (!n) return out;
	const sm = a.smooth();

	const valley = (lo: number, hi: number): [number, number, boolean] => {
		const i0 = a.i(lo);
		const i1 = Math.max(a.i(hi), a.i(lo) + 1);
		const end = Math.min(i1 + 1, a.n);
		const inactive = new Uint8Array(end - i0);
		for (let i = i0; i < end; i++) inactive[i - i0] = a.active[i] ? 0 : 1;
		let best: [number, number] | null = null;
		for (const [s, e] of runs(inactive)) {
			if ((e - s) * FRAME < 0.02) continue;
			if (!best || e - s > best[1] - best[0]) best = [s, e];
		}
		if (best) return [a.t(i0 + best[0]) - FRAME / 2, a.t(i0 + best[1]) - FRAME / 2, true];
		const j = argmin(sm, i0, end);
		return [a.t(j), a.t(j), false];
	};

	for (let k = 0; k < n - 1; k++) {
		const w0 = words[k];
		const w1 = words[k + 1];
		const m0 = (w0.startSec + w0.endSec) / 2;
		const m1 = (w1.startSec + w1.endSec) / 2;
		let lo = Math.max(m0, w0.endSec - 0.14);
		let hi = Math.min(m1, w1.startSec + 0.14);
		if (hi <= lo) {
			lo = m0;
			hi = m1;
		}
		const [g0, g1, silent] = valley(lo, hi);
		out[k].E = g0;
		out[k + 1].S = g1;
		out[k + 1].joinedBefore = !silent;
		out[k + 1].gapBefore = g1 - g0;
	}
	const first = words[0];
	const [, fg1, fSilent] = valley(Math.max(0, first.startSec - 0.4), first.startSec + 0.05);
	out[0].S = fSilent ? fg1 : Math.min(first.startSec, fg1);
	const last = words[n - 1];
	const [lg0] = valley(last.endSec - 0.05, Math.min(a.t(a.n - 1), last.endSec + 0.5));
	out[n - 1].E = lg0;
	for (let i = 0; i < n; i++) {
		const r = out[i];
		const w = words[i];
		r.S = Math.min(r.S, r.S > w.endSec ? Math.max(w.startSec, r.S) : r.S);
		if (r.E < r.S + 0.04) r.E = r.S + 0.04;
	}
	return out;
}

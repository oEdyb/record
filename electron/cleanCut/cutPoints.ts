import { type Acoustics, FPS, FRAME } from "./acoustics";
import { roundHalfEven } from "./pyCompat";
import { argmin, runs } from "./runs";

const PLATEAU_DB = 24.0;
const PLATEAU_MIN = 0.05;
const LOUD_BLOCK = 20;
const LOUD_WINDOW = 31;
const LOUD_RANK = Math.trunc((LOUD_WINDOW * 90) / 100.0);

export interface SpeechPoint {
	t: number;
	kind: "silence" | "valley";
}

/** Talker level per frame: the 90th percentile of block peaks within about 1.5 s. */
export function localLoudness(a: Acoustics): Float32Array {
	if (a.loudCache) return a.loudCache;
	const n = Math.floor(a.n / LOUD_BLOCK);
	const loc = new Float32Array(a.n);
	if (n < 2) {
		loc.fill(a.loud);
	} else {
		const blocks = new Float32Array(n);
		for (let b = 0; b < n; b++) {
			let m = a.db[b * LOUD_BLOCK];
			for (let i = 1; i < LOUD_BLOCK; i++) m = Math.max(m, a.db[b * LOUD_BLOCK + i]);
			blocks[b] = m;
		}
		const half = (LOUD_WINDOW - 1) / 2;
		const window = new Float32Array(LOUD_WINDOW);
		const smooth = new Float32Array(n);
		for (let b = 0; b < n; b++) {
			for (let k = -half; k <= half; k++) {
				window[k + half] = blocks[Math.min(Math.max(b + k, 0), n - 1)];
			}
			smooth[b] = window.slice().sort()[LOUD_RANK];
		}
		for (let i = 0; i < a.n; i++) loc[i] = smooth[Math.min(Math.floor(i / LOUD_BLOCK), n - 1)];
	}
	const floorLevel = Math.fround(a.floor + 20.0);
	for (let i = 0; i < a.n; i++) loc[i] = Math.max(loc[i], floorLevel);
	a.loudCache = loc;
	return loc;
}

/** Frame runs [start, end) far under the local talker level for at least PLATEAU_MIN. */
export function pauses(a: Acoustics): Array<[number, number]> {
	if (a.pauseCache) return a.pauseCache;
	const sm = a.smooth(3);
	const loc = localLoudness(a);
	const quiet = new Uint8Array(a.n);
	for (let i = 0; i < a.n; i++) quiet[i] = sm[i] < Math.fround(loc[i] - PLATEAU_DB) ? 1 : 0;
	a.pauseCache = runs(quiet).filter(([s, e]) => (e - s) * FRAME >= PLATEAU_MIN);
	return a.pauseCache;
}

/**
 * Where the speech the recognizer says ends near `hint` really stops: the start of the first real
 * pause at or after hint-back and not later than the next word's onset (+0.15).
 */
export function speechEnd(
	a: Acoustics,
	hint: number,
	limit: number | null,
	back = 0.02,
	ahead = 0.3,
): SpeechPoint {
	const lo = a.i(hint - back);
	let hi = a.i(limit !== null ? limit + 0.15 : hint + ahead);
	hi = Math.max(hi, a.i(hint + 0.05));
	for (const [s, e] of pauses(a)) {
		if (e <= lo) continue;
		if (s > hi) break;
		return { t: a.t(Math.max(s, lo)), kind: "silence" };
	}
	const j0 = a.i(hint - 0.02);
	const j1 = a.i(hint + 0.12);
	return { t: a.t(argmin(a.smooth(), j0, j1 + 1)), kind: "valley" };
}

/** Mirror of speechEnd: the end of the last real pause that finishes by hint+ahead. */
export function speechStart(
	a: Acoustics,
	hint: number,
	limit: number | null,
	back = 0.3,
	ahead = 0.0,
): SpeechPoint {
	let lo = a.i(limit !== null ? limit - 0.15 : hint - back);
	const hi = a.i(hint + ahead);
	lo = Math.min(lo, a.i(hint - 0.05));
	const list = pauses(a);
	for (let k = list.length - 1; k >= 0; k--) {
		const [s, e] = list[k];
		if (s >= hi) continue;
		if (e < lo) break;
		return { t: a.t(Math.min(e, hi)), kind: "silence" };
	}
	const j0 = a.i(hint - 0.12);
	const j1 = a.i(hint);
	return { t: a.t(argmin(a.smooth(), j0, j1 + 1)), kind: "valley" };
}

/** Frame-grid time in [lo, hi] with the lowest short-window energy. */
export function snapMin(
	a: Acoustics,
	lo: number,
	hi: number,
	prefer: number | null = null,
): number {
	if (hi < lo) [lo, hi] = [hi, lo];
	const k0 = Math.ceil(lo * FPS - 1e-9);
	const k1 = Math.floor(hi * FPS + 1e-9);
	if (k1 < k0) return roundHalfEven(((lo + hi) / 2) * FPS) / FPS;
	const sm = a.smooth(5);
	let best = 0;
	let bestV: number | null = null;
	for (let k = k0; k <= k1; k++) {
		const t = k / FPS;
		let v = sm[a.i(t)];
		if (prefer !== null) v += 0.02 * Math.abs(t - prefer) * 100;
		if (bestV === null || v < bestV - 1e-9) {
			best = t;
			bestV = v;
		}
	}
	return best;
}

export function frameTime(t: number): number {
	return roundHalfEven(t * FPS) / FPS;
}

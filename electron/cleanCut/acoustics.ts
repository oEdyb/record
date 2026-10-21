import { ComplexFft } from "./fft";
import { roundHalfEven } from "./pyCompat";
import { percentileFloat32 } from "./runs";

export const SR = 16000;
export const HOP = 80;
export const WIN = 400;
export const FRAME = HOP / SR;
export const FPS = 60;

const HANN = Float32Array.from({ length: WIN }, (_, i) =>
	Math.fround(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1))),
);
const FIRST_TOTAL_BIN = 2;
const FIRST_HF_BIN = 81;

/** Per-take frame features. Frame i covers [i*FRAME, i*FRAME + 25 ms). */
export class Acoustics {
	private readonly smoothed = new Map<number, Float64Array>();
	loudCache: Float32Array | null = null;
	pauseCache: Array<[number, number]> | null = null;

	constructor(
		readonly pcm: Float32Array,
		readonly db: Float32Array,
		readonly floor: number,
		readonly loud: number,
		readonly ref: number,
		readonly active: Uint8Array,
	) {}

	get n(): number {
		return this.db.length;
	}

	t(i: number): number {
		return i * FRAME + 0.0125;
	}

	i(t: number): number {
		return Math.min(Math.max(roundHalfEven((t - 0.0125) / FRAME), 0), this.n - 1);
	}

	smooth(frames = 3): Float64Array {
		let out = this.smoothed.get(frames);
		if (!out) {
			out = movingAverage(this.db, frames);
			this.smoothed.set(frames, out);
		}
		return out;
	}
}

export function movingAverage(x: ArrayLike<number>, frames: number): Float64Array {
	const n = x.length;
	const k = 1 / frames;
	const half = (frames - 1) / 2;
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let j = -half; j <= half; j++) {
			const idx = i + j;
			if (idx >= 0 && idx < n) s += k * x[idx];
		}
		out[i] = s;
	}
	return out;
}

function bandLevels(pcm: Float32Array, n: number): { db: Float32Array; hf: Float32Array } {
	const fft = new ComplexFft(WIN, [4, 4, 5, 5]);
	const db = new Float32Array(n);
	const hf = new Float32Array(n);
	const bins = WIN / 2;
	const f = Math.fround;
	const fill = (re: Float64Array, frame: number) => {
		const base = HOP * frame;
		for (let i = 0; i < WIN; i++) {
			const idx = base + i;
			re[i] = frame < n && idx < pcm.length ? f(pcm[idx] * HANN[i]) : 0;
		}
	};
	const store = (frame: number, total: number, high: number) => {
		if (frame >= n) return;
		db[frame] = f(10 * f(Math.log10(f(f(f(total) + 1e-12) / WIN))));
		hf[frame] = f(10 * f(Math.log10(f(f(f(high) + 1e-12) / WIN))));
	};
	for (let frame = 0; frame < n; frame += 2) {
		fill(fft.re, frame);
		fill(fft.im, frame + 1);
		fft.run();
		const zr = fft.outRe;
		const zi = fft.outIm;
		let totalA = 0;
		let hfA = 0;
		let totalB = 0;
		let hfB = 0;
		for (let k = FIRST_TOTAL_BIN; k <= bins; k++) {
			const c = (WIN - k) % WIN;
			const xr = (zr[k] + zr[c]) / 2;
			const xi = (zi[k] - zi[c]) / 2;
			const yr = (zi[k] + zi[c]) / 2;
			const yi = -(zr[k] - zr[c]) / 2;
			const pa = xr * xr + xi * xi;
			const pb = yr * yr + yi * yi;
			totalA += pa;
			totalB += pb;
			if (k >= FIRST_HF_BIN) {
				hfA += pa;
				hfB += pb;
			}
		}
		store(frame, totalA, hfA);
		store(frame + 1, totalB, hfB);
	}
	return { db, hf };
}

export function analyse(pcm: Float32Array): Acoustics {
	const n = pcm.length ? 1 + Math.floor((pcm.length - 1) / HOP) : 0;
	if (n === 0) return new Acoustics(pcm, new Float32Array(0), 0, 0, 0, new Uint8Array(0));
	const { db, hf } = bandLevels(pcm, n);
	const f = Math.fround;
	const floor = percentileFloat32(db, 8);
	const loud = percentileFloat32(db, 95);
	const ref = Math.max(floor + 8.0, loud - 34.0);
	const ref32 = f(ref);
	const quietHf: number[] = [];
	for (let i = 0; i < n; i++) if (db[i] <= ref32) quietHf.push(hf[i]);
	const hfFloor = quietHf.length ? percentileFloat32(quietHf, 90) : percentileFloat32(hf, 8);
	const hfFloor32 = f(hfFloor);
	const score = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		score[i] = Math.max(f(db[i] - ref32), f(f(hf[i] - hfFloor32) - 8.0));
	}
	const smoothScore = movingAverage(score, 3);
	const active = new Uint8Array(n);
	let on = false;
	for (let i = 0; i < n; i++) {
		if (!on && smoothScore[i] > 6.0) on = true;
		else if (on && smoothScore[i] < 0.0) on = false;
		active[i] = on ? 1 : 0;
	}
	return new Acoustics(pcm, db, floor, loud, ref, active);
}

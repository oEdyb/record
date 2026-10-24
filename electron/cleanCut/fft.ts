interface Level {
	size: number;
	p: number;
	m: number;
	twRe: Float64Array;
	twIm: Float64Array;
	butRe: Float64Array;
	butIm: Float64Array;
}

/** Mixed-radix complex FFT for sizes that are not a power of two (the 25 ms analysis window is 400 samples). */
export class ComplexFft {
	readonly re: Float64Array;
	readonly im: Float64Array;
	readonly outRe: Float64Array;
	readonly outIm: Float64Array;
	private readonly levels: Level[] = [];
	private readonly tr = new Float64Array(16);
	private readonly ti = new Float64Array(16);

	constructor(
		readonly n: number,
		factors: number[],
	) {
		const root = (j: number): [number, number] => [
			Math.cos((2 * Math.PI * j) / n),
			-Math.sin((2 * Math.PI * j) / n),
		];
		let size = n;
		for (const p of factors) {
			const m = size / p;
			const step = n / size;
			const level: Level = {
				size,
				p,
				m,
				twRe: new Float64Array(p * m),
				twIm: new Float64Array(p * m),
				butRe: new Float64Array(p * p),
				butIm: new Float64Array(p * p),
			};
			for (let r = 0; r < p; r++) {
				for (let k = 0; k < m; k++) {
					[level.twRe[r * m + k], level.twIm[r * m + k]] = root((r * k * step) % n);
				}
				for (let q = 0; q < p; q++) {
					[level.butRe[r * p + q], level.butIm[r * p + q]] = root((r * q * (n / p)) % n);
				}
			}
			this.levels.push(level);
			size = m;
		}
		if (size !== 1) throw new Error("FFT factors do not multiply to n.");
		this.re = new Float64Array(n);
		this.im = new Float64Array(n);
		this.outRe = new Float64Array(n);
		this.outIm = new Float64Array(n);
	}

	run(): void {
		this.rec(0, 0, 0, 1);
	}

	private rec(depth: number, outOff: number, inOff: number, stride: number): void {
		if (depth === this.levels.length) {
			this.outRe[outOff] = this.re[inOff];
			this.outIm[outOff] = this.im[inOff];
			return;
		}
		const { p, m, twRe, twIm, butRe, butIm } = this.levels[depth];
		for (let r = 0; r < p; r++) {
			this.rec(depth + 1, outOff + r * m, inOff + r * stride, stride * p);
		}
		const { tr, ti, outRe, outIm } = this;
		for (let k = 0; k < m; k++) {
			for (let r = 0; r < p; r++) {
				const idx = outOff + r * m + k;
				const c = twRe[r * m + k];
				const s = twIm[r * m + k];
				tr[r] = outRe[idx] * c - outIm[idx] * s;
				ti[r] = outRe[idx] * s + outIm[idx] * c;
			}
			for (let q = 0; q < p; q++) {
				let sr = 0;
				let si = 0;
				for (let r = 0; r < p; r++) {
					const c = butRe[r * p + q];
					const s = butIm[r * p + q];
					sr += tr[r] * c - ti[r] * s;
					si += tr[r] * s + ti[r] * c;
				}
				outRe[outOff + q * m + k] = sr;
				outIm[outOff + q * m + k] = si;
			}
		}
	}
}

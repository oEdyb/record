/** [start, endExclusive] of consecutive truthy values. */
export function runs(
	mask: ArrayLike<number | boolean>,
	from = 0,
	to = mask.length,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let start = -1;
	for (let i = from; i < to; i++) {
		if (mask[i]) {
			if (start < 0) start = i;
		} else if (start >= 0) {
			out.push([start - from, i - from]);
			start = -1;
		}
	}
	if (start >= 0) out.push([start - from, to - from]);
	return out;
}

/** First index of the smallest value in [from, to). */
export function argmin(values: ArrayLike<number>, from: number, to: number): number {
	let best = from;
	for (let i = from + 1; i < to; i++) if (values[i] < values[best]) best = i;
	return best;
}

export function percentileFloat32(values: ArrayLike<number>, q: number): number {
	const sorted = Float32Array.from(values).sort();
	const virtual = (sorted.length - 1) * (q / 100);
	const prev = Math.floor(virtual);
	const next = Math.min(prev + 1, sorted.length - 1);
	const t = virtual - prev;
	const a = sorted[prev];
	const b = sorted[next];
	const lerp = t >= 0.5 ? b - (b - a) * (1 - t) : a + (b - a) * t;
	return Math.fround(lerp);
}

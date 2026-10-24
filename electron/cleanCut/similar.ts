import type { Word } from "./words";

/** Matches found by difflib's longest-block recursion, as in SequenceMatcher.ratio. */
function matchingChars(a: string, b: string): number {
	const b2j = new Map<string, number[]>();
	for (let j = 0; j < b.length; j++) b2j.set(b[j], [...(b2j.get(b[j]) ?? []), j]);
	let total = 0;
	const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
		let besti = alo;
		let bestj = blo;
		let bestsize = 0;
		let j2len = new Map<number, number>();
		for (let i = alo; i < ahi; i++) {
			const next = new Map<number, number>();
			for (const j of b2j.get(a[i]) ?? []) {
				if (j < blo) continue;
				if (j >= bhi) break;
				const k = (j2len.get(j - 1) ?? 0) + 1;
				next.set(j, k);
				if (k > bestsize) {
					besti = i - k + 1;
					bestj = j - k + 1;
					bestsize = k;
				}
			}
			j2len = next;
		}
		if (!bestsize) continue;
		total += bestsize;
		if (alo < besti && blo < bestj) queue.push([alo, besti, blo, bestj]);
		if (besti + bestsize < ahi && bestj + bestsize < bhi) {
			queue.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
		}
	}
	return total;
}

export function similarity(a: string, b: string): number {
	const length = a.length + b.length;
	return length ? (2.0 * matchingChars(a, b)) / length : 1.0;
}

export function sameWord(a: Word, b: Word): boolean {
	if (a.n === b.n) return true;
	if (a.n.length >= 6 && b.n.length >= 6 && a.n[0] === b.n[0]) return similarity(a.n, b.n) >= 0.9;
	return false;
}

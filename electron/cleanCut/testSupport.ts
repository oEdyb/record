import { SR } from "./acoustics";
import type { RefinedWord } from "./refineWords";
import type { CleanCutTake, SpokenWord } from "./types";
import { buildWords, type Word } from "./words";

/** text, gap before in seconds (default 0.05), duration in seconds (default 0.3) */
export type Spec = string | [string, number, number?];

export function makeTake(id: string, specs: Spec[], recordedAtMs = 0): CleanCutTake {
	let t = 0.2;
	const words: SpokenWord[] = specs.map((spec) => {
		const [word, gap = 0.05, dur = 0.3] = typeof spec === "string" ? [spec] : spec;
		const startSec = t + gap;
		t = startSec + dur;
		return { word, startSec, endSec: t, confidence: 1 };
	});
	return { id, folder: "folder", key: id, recordedAtMs, pcm: new Float32Array(0), words };
}

/** Words as the decision rules see them, with acoustic times equal to the recognizer's. */
export function makeWords(takeSpecs: Spec[][]): Word[] {
	const takes = takeSpecs.map((specs, i) => makeTake(`t${i}`, specs, i * 60_000));
	const times = new Map(takes.map((t) => [t.id, t.words]));
	const refined = new Map<string, RefinedWord[]>(
		takes.map((t) => [
			t.id,
			t.words.map((w, i) => ({
				S: w.startSec,
				E: w.endSec,
				gapBefore: i ? Math.max(0, w.startSec - t.words[i - 1].endSec) : w.startSec,
				joinedBefore: false,
			})),
		]),
	);
	return buildWords(takes, times, refined);
}

/** Voiced bursts (harmonic tone) over a faint noise floor. */
export function voicePcm(durationSec: number, bursts: Array<[number, number]>): Float32Array {
	const pcm = new Float32Array(Math.round(durationSec * SR));
	let seed = 12345;
	for (let i = 0; i < pcm.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		pcm[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.0004;
	}
	for (const [from, to] of bursts) {
		for (let i = Math.round(from * SR); i < Math.min(pcm.length, Math.round(to * SR)); i++) {
			const t = i / SR;
			pcm[i] +=
				0.2 * Math.sin(2 * Math.PI * 180 * t) +
				0.1 * Math.sin(2 * Math.PI * 540 * t) +
				0.05 * Math.sin(2 * Math.PI * 1500 * t);
		}
	}
	return pcm;
}

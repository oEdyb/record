import { type Acoustics, FPS, FRAME } from "./acoustics";
import { frameTime } from "./cutPoints";
import { roundHalfEven } from "./pyCompat";
import { argmin, runs } from "./runs";
import type { CleanCutTake } from "./types";
import type { Word } from "./words";

const EDGE_DB = 26.0;
const EDGE_RUN = 0.05;
const EDGE_LEAD = 0.1;
const EDGE_TAIL = 0.16;
const EDGE_SLACK = 0.06;

export interface Clip {
	take: CleanCutTake;
	start: number;
	end: number;
	first: Word;
	last: Word;
	joinsBefore: string[];
	startKind: string;
	endKind: string;
	words: string[];
}

/**
 * Last pass: no clip may start or end on dead air. Voice is EDGE_DB under the talker's loud level
 * for at least EDGE_RUN. A clip is only ever shortened, to EDGE_LEAD before the first voice and
 * EDGE_TAIL after the last, and never past the next word's onset.
 */
export function trimEdges(
	clips: Clip[],
	acoustics: Map<string, Acoustics>,
	byTake: Map<string, Word[]>,
): number {
	let saved = 0;
	const minRun = Math.max(1, roundHalfEven(EDGE_RUN / FRAME));
	for (const c of clips) {
		const ac = acoustics.get(c.take.id) as Acoustics;
		const sm = ac.smooth();
		const lo = ac.i(c.start);
		const hi = ac.i(c.end);
		const loud = new Uint8Array(Math.max(0, hi + 1 - lo));
		for (let i = lo; i <= hi; i++) loud[i - lo] = sm[i] > ac.loud - EDGE_DB ? 1 : 0;
		const voice = runs(loud)
			.filter(([s, e]) => e - s >= minRun)
			.map(([s, e]): [number, number] => [lo + s, lo + e]);
		const ws = byTake.get(c.take.id) as Word[];
		const prv = c.first.ti ? ws[c.first.ti - 1] : null;
		const nxt = c.last.ti + 1 < ws.length ? ws[c.last.ti + 1] : null;
		const late = Math.max(c.last.E + EDGE_SLACK, nxt ? nxt.S - EDGE_SLACK : c.end);
		const early = Math.min(c.first.S - EDGE_SLACK, prv ? prv.E + EDGE_SLACK : c.start);
		const mine = voice.filter(([s, e]) => ac.t(s) < late && ac.t(e) > early);
		if (!mine.length) continue;
		const firstVoice = mine[0];
		const lastVoice = mine[mine.length - 1];
		let start = Math.max(c.start, frameTime(ac.t(firstVoice[0]) - EDGE_LEAD));
		let end = Math.min(c.end, frameTime(ac.t(lastVoice[1]) + EDGE_TAIL));
		const before = voice.filter((r) => r[1] <= firstVoice[0]);
		const after = voice.filter((r) => r[0] >= lastVoice[1]);
		if (before.length) {
			const a = before[before.length - 1][1];
			start = Math.max(start, frameTime(ac.t(argmin(sm, a, firstVoice[0] + 1))));
		}
		if (after.length) {
			const b = after[0][0];
			end = Math.min(end, frameTime(ac.t(argmin(sm, lastVoice[1], b + 1))));
		}
		if (end - start < 2 / FPS) continue;
		saved += start - c.start + (c.end - end);
		c.start = start;
		c.end = end;
	}
	return saved;
}

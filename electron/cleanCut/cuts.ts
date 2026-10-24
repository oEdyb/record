import { type Acoustics, FPS } from "./acoustics";
import { snapMin, speechEnd, speechStart } from "./cutPoints";
import type { DropMap } from "./decide";
import { type Clip, trimEdges } from "./edgeTrim";
import type { TimeSpan } from "./hesitations";
import type { CleanCutTake } from "./types";
import { isComma, isTerminal, type Word } from "./words";

export const PAUSE_MAX = 0.8;
const PAD_CAP = 0.22;
const PAUSE_SENTENCE = 0.42;
const PAUSE_COMMA = 0.26;
const PAUSE_PHRASE = 0.2;
const START_LEAD = 0.1;
const END_TAIL = 0.28;
const MIN_TAIL = 0.1;
const MIN_LEAD = 0.07;

export interface PlanStats {
	joins: number;
	compressedPauses: number;
	hesitationsCut: number;
	silenceSavedSec: number;
	edgeSilenceTrimmedSec: number;
}

export interface CutsPlan {
	clips: Clip[];
	stats: PlanStats;
	byTake: Map<string, Word[]>;
}

function pauseTarget(a: Word): number {
	if (isTerminal(a)) return PAUSE_SENTENCE;
	if (isComma(a)) return PAUSE_COMMA;
	return PAUSE_PHRASE;
}

/** Earliest moment after `end` where something else starts: the next word's true onset or an unwritten hesitation. */
function nextSound(
	ac: Acoustics,
	end: number,
	nxt: Word | null,
	a: Word,
	events: TimeSpan[],
): number {
	let t = nxt ? speechStart(ac, nxt.s, a.e).t : end + 1.0;
	for (const [s] of events) {
		if (s > end - 0.02) {
			t = Math.min(t, s);
			break;
		}
	}
	return t;
}

function prevSound(
	ac: Acoustics,
	start: number,
	prv: Word | null,
	b: Word,
	events: TimeSpan[],
): number {
	let t = prv ? speechEnd(ac, prv.e, b.s).t : start - 1.0;
	for (let k = events.length - 1; k >= 0; k--) {
		if (events[k][1] < start + 0.02) {
			t = Math.max(t, events[k][1]);
			break;
		}
	}
	return t;
}

function cutOut(
	ac: Acoustics,
	a: Word,
	nxt: Word | null,
	tail: number | null,
	events: TimeSpan[],
): [number, string] {
	const point = speechEnd(ac, a.e, nxt ? nxt.s : null);
	const end = point.t;
	if (point.kind === "valley") return [snapMin(ac, end - 0.02, end + 0.02, end), "valley"];
	const limit = nextSound(ac, end, nxt, a, events);
	const avail = Math.max(0, limit - end - 0.02);
	const want = Math.min(PAD_CAP, avail, tail !== null ? tail : PAD_CAP);
	const lo = end + Math.min(MIN_TAIL, avail * 0.5);
	const hi = Math.min(end + Math.max(want, MIN_TAIL), end + avail);
	return [snapMin(ac, lo, Math.max(hi, lo), end + want), point.kind];
}

function cutIn(
	ac: Acoustics,
	b: Word,
	prv: Word | null,
	lead: number | null,
	events: TimeSpan[],
): [number, string] {
	const point = speechStart(ac, b.s, prv ? prv.e : null);
	const start = point.t;
	if (point.kind === "valley") return [snapMin(ac, start - 0.02, start + 0.02, start), "valley"];
	const limit = prevSound(ac, start, prv, b, events);
	const avail = Math.max(0, start - limit - 0.02);
	const want = Math.min(PAD_CAP, avail, lead !== null ? lead : PAD_CAP);
	const hi = start - Math.min(MIN_LEAD, avail * 0.5);
	let lo = start - Math.max(want, MIN_LEAD);
	lo = Math.max(lo, start - avail);
	return [snapMin(ac, Math.min(lo, hi), hi, start - want), point.kind];
}

const takeKey = (w: Word) => w.take.id;

/**
 * Turns word keep/drop decisions into clips whose in and out points are placed from the audio:
 * the quietest 5 ms next to the word each cut protects, on a whole 1/60 s frame.
 */
export function planCuts(
	words: Word[],
	drop: DropMap,
	editTakes: CleanCutTake[],
	acoustics: Map<string, Acoustics>,
	hesit: Map<string, TimeSpan[]>,
	pauseMax = PAUSE_MAX,
): CutsPlan {
	const byTake = new Map<string, Word[]>();
	for (const w of words) byTake.set(takeKey(w), [...(byTake.get(takeKey(w)) ?? []), w]);
	const clips: Clip[] = [];
	const stats: PlanStats = {
		joins: 0,
		compressedPauses: 0,
		hesitationsCut: 0,
		silenceSavedSec: 0,
		edgeSilenceTrimmedSec: 0,
	};
	for (const take of editTakes) {
		const ws = byTake.get(take.id) ?? [];
		const kept = ws.filter((w) => !drop.has(w.gi));
		if (!kept.length) continue;
		const ac = acoustics.get(take.id) as Acoustics;
		const events = hesit.get(take.id) ?? [];
		const runFirst = kept[0];
		const [inStart, inKind] = cutIn(
			ac,
			runFirst,
			runFirst.ti ? ws[runFirst.ti - 1] : null,
			START_LEAD,
			events,
		);
		let cur: Clip = {
			take,
			start: inStart,
			end: 0,
			first: runFirst,
			last: runFirst,
			joinsBefore: [],
			startKind: inKind !== "silence" ? inKind : "take-start",
			endKind: "",
			words: [],
		};
		for (let k = 0; k + 1 < kept.length; k++) {
			const a = kept[k];
			const b = kept[k + 1];
			const between = ws.slice(a.ti + 1, b.ti);
			const ev = events.filter(([s, e]) => s >= a.e - 0.05 && e <= b.s + 0.05);
			const silence = Math.max(0, b.S - a.E);
			const reasons: string[] = [];
			if (between.length) {
				const why = drop.get(between[0].gi);
				const text = between
					.slice(0, 8)
					.map((w) => w.text)
					.join(" ");
				reasons.push(
					`${why?.kind}: dropped "${text}${between.length > 8 ? " ..." : ""}" (${why?.reason})`,
				);
			}
			if (ev.length) {
				reasons.push(`hesitation ${ev.reduce((n, [s, e]) => n + (e - s), 0).toFixed(2)}s`);
				stats.hesitationsCut += ev.length;
			}
			if (!reasons.length && silence > pauseMax) {
				reasons.push(`pause ${silence.toFixed(2)}s`);
				stats.compressedPauses += 1;
			}
			if (!reasons.length) {
				cur.last = b;
				continue;
			}
			const target = pauseTarget(a);
			const aNext = ws[a.ti + 1];
			const bPrev = ws[b.ti - 1];
			const aEnd = speechEnd(ac, a.e, aNext.s);
			const bStart = speechStart(ac, b.s, bPrev.e);
			const tailRoom =
				aEnd.kind === "valley" ? 0 : Math.max(0, nextSound(ac, aEnd.t, aNext, a, events) - aEnd.t);
			const leadRoom =
				bStart.kind === "valley"
					? 0
					: Math.max(0, bStart.t - prevSound(ac, bStart.t, bPrev, b, events));
			const tail = Math.min(PAD_CAP, target / 2, tailRoom);
			const lead = Math.min(PAD_CAP, Math.max(target - tail, target / 2), leadRoom);
			const [oT, oKind] = cutOut(ac, a, aNext, tail, events);
			const [iT, iKind] = cutIn(ac, b, bPrev, lead, events);
			cur.last = a;
			cur.end = oT;
			cur.endKind = oKind;
			stats.joins += 1;
			stats.silenceSavedSec += Math.max(0, iT - oT);
			clips.push(cur);
			cur = {
				take,
				start: iT,
				end: 0,
				first: b,
				last: b,
				joinsBefore: reasons,
				startKind: iKind,
				endKind: "",
				words: [],
			};
		}
		const after = cur.last.ti + 1 < ws.length ? ws[cur.last.ti + 1] : null;
		const [endT, endKind] = cutOut(ac, cur.last, after, END_TAIL, events);
		cur.end = endT;
		cur.endKind = endKind;
		clips.push(cur);
	}
	for (const c of clips) {
		if (c.end <= c.start) c.end = c.start + 1 / FPS;
		const ws = byTake.get(c.take.id) as Word[];
		c.words = ws
			.slice(c.first.ti, c.last.ti + 1)
			.filter((w) => !drop.has(w.gi))
			.map((w) => w.text);
	}
	stats.edgeSilenceTrimmedSec = trimEdges(clips, acoustics, byTake);
	return { clips, stats, byTake };
}

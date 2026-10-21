import type { DropMap, Why } from "./decide";
import { sameWhy } from "./decide";
import type { Clip } from "./edgeTrim";
import type { CleanCutTake, CutRegion } from "./types";
import type { Word } from "./words";

const SMALL = new Set(["filler", "stutter"]);
const END_MARGIN_SEC = 0.5;
const MAX_SCORED_SEC = 15.0;

interface Run {
	words: Word[];
	why: Why;
}

/** Consecutive dropped words of one take that were cut for the same reason. */
export function dropRuns(words: Word[], drop: DropMap): Run[] {
	const runs: Run[] = [];
	for (const w of words) {
		const why = drop.get(w.gi);
		if (!why) continue;
		const last = runs[runs.length - 1];
		const prev = last?.words[last.words.length - 1];
		if (last && prev && prev.take === w.take && prev.ti === w.ti - 1 && sameWhy(last.why, why)) {
			last.words.push(w);
		} else {
			runs.push({ words: [w], why });
		}
	}
	return runs;
}

/** Where things play in the cut: seconds from its start. */
export class Clock {
	private readonly starts = [0];

	constructor(
		private readonly clips: Clip[],
		private readonly order: Map<string, number>,
	) {
		for (const c of clips) this.starts.push(this.starts[this.starts.length - 1] + c.end - c.start);
	}

	get length(): number {
		return this.starts[this.starts.length - 1];
	}

	/** The moment source time t of this take plays, or where the cut lands if it was cut. */
	at(take: CleanCutTake, t: number): number {
		const rank = this.order.get(take.id) as number;
		for (let i = 0; i < this.clips.length; i++) {
			const c = this.clips[i];
			const cr = this.order.get(c.take.id) as number;
			if (cr > rank || (cr === rank && c.end > t)) {
				const inside = c.take === take && c.start <= t;
				return this.starts[i] + (inside ? t - c.start : 0);
			}
		}
		return this.length;
	}

	where(take: CleanCutTake, t: number): number | null {
		const at = this.at(take, t);
		return at < this.length - END_MARGIN_SEC ? at : null;
	}
}

function grams(ws: Word[]): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + 2 < ws.length; i++) out.add(`${ws[i].n} ${ws[i + 1].n} ${ws[i + 2].n}`);
	return out;
}

function keptGrams(words: Word[], drop: DropMap): Set<string> {
	const out = new Set<string>();
	let take: Word["take"] | null = null;
	let seq: Word[] = [];
	for (const w of [...words, null]) {
		if (w === null || w.take !== take) {
			for (const g of grams(seq)) out.add(g);
			take = w ? w.take : null;
			seq = [];
		}
		if (w !== null && !drop.has(w.gi)) seq.push(w);
	}
	return out;
}

/** How far to trust a cut: rules are firm, a model alone is not, two independent passes agreeing is stronger. */
function doubt(why: Why): number {
	const s = new Set(why.sources);
	const base = !s.has("rule") ? 1.0 : s.has("model") ? 0.6 : 0.3;
	return s.has("session") && (s.has("rule") || s.has("model")) ? base * 0.5 : base;
}

/**
 * Every cut as a region, with the ones most worth a listen flagged: long, decided by a model
 * alone, and not repeated anywhere in the cut.
 */
export function cutRegions(
	words: Word[],
	drop: DropMap,
	clips: Clip[],
	order: Map<string, number>,
	listenFirstLimit: number,
): CutRegion[] {
	const clock = new Clock(clips, order);
	const kept = keptGrams(words, drop);
	const regions = dropRuns(words, drop).map((r) => {
		const first = r.words[0];
		const last = r.words[r.words.length - 1];
		const seconds = last.E - first.S;
		const g = grams(r.words);
		let covered = 1.0;
		if (g.size) covered = [...g].filter((x) => kept.has(x)).length / g.size;
		const lonely = r.words.length >= 6 && covered < 0.3;
		const eligible = !SMALL.has(r.why.kind) && r.words.length >= 3;
		const riskScore = eligible
			? doubt(r.why) * (lonely ? 2 : 1) * Math.min(seconds, MAX_SCORED_SEC)
			: 0;
		const flags: string[] = [];
		if (eligible && lonely) flags.push("no-kept-repeat");
		const only = r.why.sources.length === 1 ? r.why.sources[0] : null;
		if (eligible && (only === "model" || only === "session")) flags.push("single-model");
		const keptWord = r.why.keep.length ? words[r.why.keep[0]] : null;
		const region: CutRegion = {
			takeId: first.take.id,
			firstWordIndex: first.ti,
			lastWordIndex: last.ti,
			text: r.words.map((w) => w.text).join(" "),
			startSec: first.S,
			endSec: last.E,
			kind: r.why.kind,
			reason: r.why.reason,
			sources: r.why.sources,
			timelineSec: clock.where(first.take, first.S),
			keptTimelineSec: keptWord ? clock.where(keptWord.take, keptWord.S) : null,
			risky: false,
			riskScore,
			riskFlags: flags,
		};
		return region;
	});
	const top = regions
		.map((r, index) => ({ r, index }))
		.filter(({ r }) => r.riskScore > 0)
		.sort((a, b) => b.r.riskScore - a.r.riskScore || a.index - b.index)
		.slice(0, listenFirstLimit);
	for (const { r } of top) r.risky = true;
	return regions;
}

import { type Acoustics, analyse } from "./acoustics";
import { PAUSE_MAX, planCuts } from "./cuts";
import { type Decision, type DropMap, decide } from "./decide";
import { fillers } from "./fillers";
import { hesitationCandidates, type TimeSpan, vetHesitations } from "./hesitations";
import { type RefinedWord, refineWords } from "./refineWords";
import { restarts } from "./restarts";
import { retakes } from "./retakes";
import { cutRegions } from "./risk";
import { mergeSession, type SessionDrop, sessionDrops } from "./session";
import type { CleanCutInput, CleanCutPlan, CleanCutTake, DroppedWord, WordTime } from "./types";
import { splitUnits } from "./units";
import { buildWords, unitWords } from "./words";

const LISTEN_FIRST_LIMIT = 8;

function placementTimes(take: CleanCutTake): WordTime[] {
	if (!take.alignedTimes) return take.words;
	if (take.alignedTimes.length !== take.words.length) {
		throw new Error(`Take ${take.id} needs one aligned time per word.`);
	}
	return take.alignedTimes;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The clean-cut engine. Decisions use the recognizer's word times; only cut placement uses the
 * aligned times. Model and hesitation checks are injected, so nothing here touches Electron or the disk.
 */
export async function planCleanCut(input: CleanCutInput): Promise<CleanCutPlan> {
	const { takes, vetter = null, options = {} } = input;
	const model = input.model ?? null;
	const skipped: string[] = [];
	const acoustics = new Map<string, Acoustics>();
	const decisionTimes = new Map<string, WordTime[]>();
	const refined = new Map<string, RefinedWord[]>();
	const placeTimes = new Map<string, WordTime[]>();
	const placeRefined = new Map<string, RefinedWord[]>();
	for (const take of takes) {
		const a = analyse(take.pcm);
		const placed = placementTimes(take);
		const own = refineWords(a, take.words);
		acoustics.set(take.id, a);
		decisionTimes.set(take.id, take.words);
		refined.set(take.id, own);
		placeTimes.set(take.id, placed);
		placeRefined.set(take.id, take.alignedTimes ? refineWords(a, placed) : own);
	}
	const units = splitUnits(takes);
	const words = buildWords(takes, decisionTimes, refined);
	const wordOf = unitWords(words);
	const placed = takes.some((t) => t.alignedTimes)
		? buildWords(takes, placeTimes, placeRefined)
		: words;

	const hesitations = new Map<string, TimeSpan[]>();
	let candidatesSeen = 0;
	let confirmed = 0;
	for (const take of takes) {
		const a = acoustics.get(take.id) as Acoustics;
		const found = hesitationCandidates(a, placeTimes.get(take.id) as WordTime[]);
		const kept = vetter ? await vetHesitations(a, found, vetter) : [];
		hesitations.set(take.id, kept);
		candidatesSeen += found.length;
		confirmed += kept.length;
	}

	const cands = [
		...fillers(words, options.fillers ?? "paused"),
		...restarts(words),
		...retakes(words),
	];
	let decision: Decision;
	try {
		decision = await decide(words, cands, model);
	} catch (e) {
		skipped.push(`word-level model call: ${message(e)}`);
		decision = await decide(words, cands, null);
	}
	let session: SessionDrop[] = [];
	let sessionOnly = 0;
	if (model) {
		try {
			session = await sessionDrops(units, model);
			sessionOnly = mergeSession(wordOf, units, session, decision.drop);
		} catch (e) {
			skipped.push(`whole-session model pass: ${message(e)}`);
		}
	}
	const drop: DropMap = decision.drop;

	const plan = planCuts(
		placed,
		drop,
		takes,
		acoustics,
		hesitations,
		options.pauseMaxSec ?? PAUSE_MAX,
	);
	const order = new Map(takes.map((t, i) => [t.id, i]));
	const cuts = cutRegions(
		words,
		drop,
		plan.clips,
		order,
		options.listenFirstLimit ?? LISTEN_FIRST_LIMIT,
	);

	const dropped: DroppedWord[] = [];
	for (const w of words) {
		const why = drop.get(w.gi);
		if (!why) continue;
		dropped.push({
			takeId: w.take.id,
			wordIndex: w.ti,
			word: w.text,
			startSec: w.S,
			endSec: w.E,
			kind: why.kind,
			reason: why.reason,
			sources: why.sources,
		});
	}
	const cleanTimelineSec = plan.clips.reduce((n, c) => n + (c.end - c.start), 0);
	return {
		takes: takes.map((take) => ({
			takeId: take.id,
			clips: plan.clips
				.filter((c) => c.take === take)
				.map((c) => ({
					startSec: c.start,
					endSec: c.end,
					firstWordIndex: c.first.ti,
					lastWordIndex: c.last.ti,
					words: c.words,
					joinReasons: c.joinsBefore,
					startKind: c.startKind,
					endKind: c.endKind,
				})),
		})),
		dropped,
		cuts,
		stats: {
			takes: takes.length,
			words: words.length,
			droppedWords: dropped.length,
			cuts: cuts.length,
			clips: plan.clips.length,
			joins: plan.stats.joins,
			compressedPauses: plan.stats.compressedPauses,
			hesitationCandidates: candidatesSeen,
			hesitationsConfirmed: confirmed,
			hesitationsCut: plan.stats.hesitationsCut,
			sessionOnlyWords: sessionOnly,
			silenceSavedSec: plan.stats.silenceSavedSec,
			edgeSilenceTrimmedSec: plan.stats.edgeSilenceTrimmedSec,
			spokenSec: words.reduce((n, w) => n + (w.E - w.S), 0),
			cleanTimelineSec,
		},
		skipped,
	};
}

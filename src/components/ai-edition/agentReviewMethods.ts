import type { ListenMode } from "@/components/ai-edition/cleanCut/useCleanCutGuide";
import type { AgentMethods } from "@/lib/agent/useAgentControl";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { regionAppliesAt } from "@/lib/cleanCut/keep";
import type { CleanCutReviewModel, ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import type { CleanCutStrength } from "@/lib/cleanCut/types";
import { sentenceAround, userCutRegion } from "@/lib/cleanCut/userCuts";

/** What the review shell lends the agent: the same handlers its own controls call. */
export interface AgentReviewContext {
	projectId: string | null;
	projectTitle: string | null;
	assets: ReadonlyArray<{
		id: string;
		originalPath: string;
		microphoneAudioPath?: string | null;
		microphoneAudioOffsetMs?: number | null;
	}>;
	cleanCutAvailable: boolean;
	review: CleanCutReviewModel | null;
	toPlaybackSec: (rawSec: number) => number;
	toRawSec: (playbackSec: number) => number;
	playbackDurationSec: number;
	seekRaw: (rawSec: number) => void;
	play: () => void;
	pause: () => void;
	selectCut: (cut: ReviewCut) => void;
	audition: (cut: ReviewCut, mode: ListenMode) => void;
	save: () => void;
}

const CONTEXT_WORDS = 8;
const round = (sec: number) => Math.round(sec * 1000) / 1000;

function requireReview(context: AgentReviewContext): CleanCutReviewModel {
	if (context.review) return context.review;
	const { enabled, snapshot } = useCleanCutStore.getState();
	if (!enabled) throw new Error("Clean cut is off. Call cleanCut.enable first.");
	if (snapshot.state === "failed") throw new Error(`Clean cut failed: ${snapshot.error}`);
	throw new Error(
		`Clean cut is not ready yet (${snapshot.state}, ${snapshot.stage ?? "starting"}).`,
	);
}

function findCut(context: AgentReviewContext, id: unknown): ReviewCut {
	const cut = requireReview(context).strip.find((c) => c.region.id === id);
	if (!cut) throw new Error(`No cut with id ${String(id)} at this strength. List them with cuts.`);
	return cut;
}

function describeCut(context: AgentReviewContext, cut: ReviewCut) {
	const { snapshot } = useCleanCutStore.getState();
	const indexes = snapshot.words.flatMap((w, i) => (w.regionId === cut.region.id ? [i] : []));
	const first = indexes[0] ?? -1;
	const last = indexes.at(-1) ?? -1;
	const sameAsset = (i: number) => snapshot.words[i]?.assetId === cut.region.assetId;
	const around = (from: number, to: number) =>
		snapshot.words
			.slice(Math.max(0, from), Math.max(0, to))
			.filter((_, k) => sameAsset(Math.max(0, from) + k))
			.map((w) => w.text)
			.join(" ");
	return {
		id: cut.region.id,
		kind: cut.region.kind,
		words: cut.region.words.join(" "),
		reason: cut.region.reason,
		sources: cut.region.sources,
		unsure: cut.region.risky,
		restored: cut.restored,
		removedSec: round(cut.removedSec),
		playbackSec: round(context.toPlaybackSec(cut.rawStartSec)),
		rawStartSec: round(cut.rawStartSec),
		rawEndSec: round(cut.rawEndSec),
		before: first >= 0 ? around(first - CONTEXT_WORDS, first) : undefined,
		after: last >= 0 ? around(last + 1, last + 1 + CONTEXT_WORDS) : undefined,
	};
}

export function agentReviewMethods(context: AgentReviewContext): AgentMethods {
	const store = () => useCleanCutStore.getState();
	return {
		state: () => {
			const project = useProjectStore.getState();
			const { enabled, snapshot, strength, restored, userCuts, undoSteps, redoSteps } = store();
			const review = context.review;
			return {
				project: { id: context.projectId, title: context.projectTitle },
				playback: {
					playing: project.playing,
					rawSec: round(project.currentTimeSec),
					playbackSec: round(context.toPlaybackSec(project.currentTimeSec)),
					durationSec: round(context.playbackDurationSec),
				},
				cleanCut: {
					available: context.cleanCutAvailable,
					enabled,
					state: snapshot.state,
					stage: snapshot.stage ?? null,
					progress: snapshot.progress,
					error: snapshot.error,
					modelCheck: snapshot.modelCheck,
					strength,
					rawDurationSec: snapshot.rawDurationSec,
					keptSec: review ? round(review.keptSec) : null,
					cuts: review?.strip.length ?? 0,
					wordCuts: review?.cuts.length ?? 0,
					unsure: review?.unsureCount ?? 0,
					restored: restored.size,
					userCuts: userCuts.length,
					canUndo: undoSteps.length > 0,
					canRedo: redoSteps.length > 0,
				},
			};
		},
		"cleanCut.enable": (params) => {
			if (!context.cleanCutAvailable)
				throw new Error("Clean cut is not available for this project.");
			store().setEnabled(params.on !== false, context.projectId);
			return { enabled: store().enabled };
		},
		"cleanCut.strength": (params) => {
			const value = params.value as CleanCutStrength;
			if (value !== "gentle" && value !== "clean")
				throw new Error('strength is "gentle" or "clean".');
			store().setStrength(value);
			return { strength: store().strength };
		},
		"cleanCut.retry": () => {
			store().retry();
			return { retrying: true };
		},
		cuts: (params) => {
			const review = requireReview(context);
			const kinds = typeof params.kind === "string" ? new Set(params.kind.split(",")) : null;
			const list = params.order === "review" ? review.cuts : review.strip;
			return list
				.filter((cut) => !kinds || kinds.has(cut.region.kind))
				.filter((cut) => !params.unsure || cut.region.risky)
				.map((cut) => describeCut(context, cut));
		},
		cut: (params) => describeCut(context, findCut(context, params.id)),
		"cut.restore": (params) => {
			const ids = (Array.isArray(params.ids) ? params.ids : [params.id]).map(String);
			for (const id of ids) findCut(context, id);
			store().setRestoredMany(ids, params.restored !== false);
			return { ids, restored: params.restored !== false };
		},
		"cut.select": (params) => {
			const cut = findCut(context, params.id);
			context.selectCut(cut);
			return describeCut(context, cut);
		},
		"cut.listen": (params) => {
			// Audible on the viewer's speakers: only when they asked to hear it.
			const cut = findCut(context, params.id);
			const mode: ListenMode = params.mode === "without" ? "without" : "with";
			context.audition(cut, mode);
			return { playing: cut.region.id, mode };
		},
		"cut.source": (params) => {
			const cut = findCut(context, params.id);
			const asset = context.assets.find((a) => a.id === cut.region.assetId);
			if (!asset) throw new Error(`The recording for cut ${cut.region.id} is not in this project.`);
			const review = requireReview(context);
			return {
				id: cut.region.id,
				audioPath: asset.microphoneAudioPath ?? asset.originalPath,
				offsetSec: asset.microphoneAudioPath ? (asset.microphoneAudioOffsetMs ?? 0) / 1000 : 0,
				removedStartSec: cut.region.removedStartSec,
				removedEndSec: cut.region.removedEndSec,
				keep: review.keep
					.filter((k) => k.assetId === cut.region.assetId)
					.map(({ startSec, endSec }) => ({ startSec, endSec })),
			};
		},
		transcript: (params) => {
			const { snapshot, strength, restored } = store();
			requireReview(context);
			const active = new Set(
				snapshot.regions
					.filter((r) => regionAppliesAt(r, strength) && !restored.has(r.id))
					.map((r) => r.id),
			);
			const from = Math.max(0, Number(params.from ?? 0));
			const count = Math.min(2000, Math.max(1, Number(params.count ?? 400)));
			return {
				total: snapshot.words.length,
				words: snapshot.words.slice(from, from + count).map((w, k) => ({
					index: from + k,
					text: w.text,
					assetId: w.assetId,
					startSec: round(w.startSec),
					endSec: round(w.endSec),
					cutBy: w.regionId && active.has(w.regionId) ? w.regionId : null,
				})),
			};
		},
		"cut.sentence": (params) => {
			const { snapshot } = store();
			requireReview(context);
			const index = Number(params.wordIndex);
			const sentence = sentenceAround(snapshot.words, index);
			if (!sentence) throw new Error(`Word ${index} is already cut or does not exist.`);
			const region = userCutRegion(snapshot.words, snapshot.keep, sentence[0], sentence[1]);
			store().cutSentence(region);
			return { id: region.id, words: region.words.join(" ") };
		},
		undo: () => {
			store().undo();
			return { canUndo: store().undoSteps.length > 0 };
		},
		redo: () => {
			store().redo();
			return { canRedo: store().redoSteps.length > 0 };
		},
		play: () => {
			context.play();
			return { playing: true };
		},
		pause: () => {
			context.pause();
			return { playing: false };
		},
		seek: (params) => {
			const sec = Number(params.sec);
			if (!Number.isFinite(sec)) throw new Error("seek needs sec.");
			const raw = params.clock === "raw" ? sec : context.toRawSec(sec);
			context.seekRaw(raw);
			return { rawSec: round(raw), playbackSec: round(context.toPlaybackSec(raw)) };
		},
		save: () => {
			context.save();
			return { opened: "save" };
		},
	};
}

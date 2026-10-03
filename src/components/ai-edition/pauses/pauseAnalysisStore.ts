import { create } from "zustand";
import { applyPauseSuggestions } from "@/lib/ai-edition/document/pause-edits";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { PauseAnalysisPolicy } from "@/lib/ai-edition/timeline/pause-analysis";
import {
	cutInDocument,
	cutRangeKey,
	type ProposedCut,
	type SelectablePauseSuggestion,
} from "@/lib/ai-edition/timeline/proposed-cuts";
import { rememberRejectedCut, wasCutRejected } from "./rejectedCuts";

export type { SelectablePauseSuggestion } from "@/lib/ai-edition/timeline/proposed-cuts";

import { analyzeProjectPauses, type ProjectPauseAnalysisResult } from "./analyzeProjectPauses";

export type PauseAnalysisStatus = "idle" | "analyzing" | "ready" | "error";

interface PauseAnalysisState {
	projectId: string | null;
	revision: number | null;
	status: PauseAnalysisStatus;
	analysis: ProjectPauseAnalysisResult | null;
	suggestions: SelectablePauseSuggestion[];
	rejectedEarlier: number;
	accepting: boolean;
	stageCuts: (cuts: ProposedCut[]) => string[];
	moveCutEdge: (id: string, edge: "start" | "end", sourceSec: number) => void;
	removeCut: (id: string) => void;
	rejectCut: (id: string) => void;
	clearCuts: () => void;
	acceptAll: (
		ids?: string[],
		requestId?: string,
	) => Promise<"applied" | "unchanged" | "conflict" | "project-changed">;
	syncDocument: (projectId: string | null, revision: number) => void;
	analyze: (
		document: AxcutDocument,
		revision: number,
		policy: PauseAnalysisPolicy,
	) => Promise<void>;
	setSuggestions: (suggestions: SelectablePauseSuggestion[]) => void;
	toggleSuggestion: (suggestionId: string) => void;
	invalidate: () => void;
}

const emptyAnalysisState = {
	status: "idle" as const,
	analysis: null,
	suggestions: [],
	rejectedEarlier: 0,
};

let runSequence = 0;
let activeRun: {
	projectId: string;
	runId: number;
	controller: AbortController;
} | null = null;

function abortActiveRun(): void {
	activeRun?.controller.abort();
	activeRun = null;
}

export const usePauseAnalysisStore = create<PauseAnalysisState>()((set, get) => ({
	projectId: null,
	revision: null,
	accepting: false,
	...emptyAnalysisState,

	syncDocument(projectId, revision) {
		if (get().projectId === projectId && get().revision === revision) return;
		abortActiveRun();
		const document = useProjectStore.getState().document;
		if (get().projectId !== projectId || !document || document.project.id !== projectId) {
			set({ projectId, revision, ...emptyAnalysisState });
			return;
		}
		const suggestions = get().suggestions.flatMap((cut) => {
			if (!get().accepting && (cut.kind === "pause" || cut.kind === "blip")) return [];
			const next = cutInDocument(cut, document);
			return next ? [next] : [];
		});
		set({ revision, suggestions, status: suggestions.length ? "ready" : "idle", analysis: null });
	},

	async analyze(document, revision, policy) {
		const projectId = document.project.id;
		get().syncDocument(projectId, revision);
		abortActiveRun();

		const runId = ++runSequence;
		const controller = new AbortController();
		activeRun = { projectId, runId, controller };
		set({
			status: "analyzing",
			analysis: null,
			suggestions: get().suggestions.filter((cut) => cut.kind === "agent" || cut.kind === "fix"),
		});

		try {
			const analysis = await analyzeProjectPauses(document, policy, controller.signal);
			if (controller.signal.aborted) return;
			if (activeRun?.runId !== runId || get().projectId !== projectId) return;

			const project = useProjectStore.getState();
			if (project.projectId !== projectId || project.revision !== revision) {
				set({ status: "idle", analysis: null });
				return;
			}

			set({ status: "ready", analysis });
			get().stageCuts(
				analysis.suggestions.map((cut) => ({ ...cut, origin: "Shorten Pauses", selected: true })),
			);
		} catch (error) {
			if (controller.signal.aborted) return;
			if (activeRun?.runId !== runId || get().projectId !== projectId) return;
			console.error("Pause analysis failed", error);
			set({ status: "error", analysis: null });
		} finally {
			if (activeRun?.runId === runId) activeRun = null;
		}
	},

	setSuggestions(suggestions) {
		if (get().accepting) return;
		set({ suggestions });
	},

	toggleSuggestion(suggestionId) {
		if (get().accepting) return;
		set((state) => ({
			suggestions: state.suggestions.map((suggestion) =>
				suggestion.id === suggestionId
					? { ...suggestion, selected: !suggestion.selected }
					: suggestion,
			),
		}));
	},

	stageCuts(cuts) {
		const project = useProjectStore.getState();
		if (!project.document || !project.projectId || get().accepting) return [];
		get().syncDocument(project.projectId, project.revision);
		const suggestions = [...get().suggestions];
		const staged: string[] = [];
		let rejectedEarlier = 0;
		for (const input of cuts) {
			const cut = cutInDocument(input, project.document);
			if (!cut) continue;
			if (
				cut.replacesTrim &&
				suggestions.some((item) => item.replacesTrim?.id === cut.replacesTrim?.id)
			)
				continue;
			if (wasCutRejected(project.projectId, cut)) {
				rejectedEarlier++;
				continue;
			}
			if (
				suggestions.some(
					(item) =>
						item.id === cut.id ||
						(cut.proposalKey !== undefined && item.proposalKey === cut.proposalKey) ||
						cutRangeKey(item) === cutRangeKey(cut),
				)
			)
				continue;
			if (
				suggestions.some(
					(item) =>
						item.clipId === cut.clipId &&
						item.sourceStartSec < cut.sourceEndSec &&
						item.sourceEndSec > cut.sourceStartSec,
				)
			)
				continue;
			suggestions.push(cut);
			staged.push(cut.id);
		}
		set({ suggestions, rejectedEarlier, status: "ready" });
		return staged;
	},

	moveCutEdge(id, edge, sourceSec) {
		if (!Number.isFinite(sourceSec) || get().accepting) return;
		const document = useProjectStore.getState().document;
		const cut = get().suggestions.find((item) => item.id === id);
		const clip = document?.timeline.clips.find(
			(item) => item.id === cut?.clipId && item.assetId === cut.assetId,
		);
		if (
			!document ||
			document.project.id !== get().projectId ||
			!cut ||
			!clip ||
			clip.sourceEndSec === undefined
		)
			return;
		const neighbours = get().suggestions.filter(
			(item) => item.id !== id && item.clipId === cut.clipId,
		);
		const lower = Math.max(
			clip.sourceStartSec,
			...neighbours
				.filter((item) => item.sourceEndSec <= cut.sourceStartSec)
				.map((item) => item.sourceEndSec),
		);
		const upper = Math.min(
			clip.sourceEndSec,
			...neighbours
				.filter((item) => item.sourceStartSec >= cut.sourceEndSec)
				.map((item) => item.sourceStartSec),
		);
		const next = cutInDocument(
			{
				...cut,
				...(edge === "start"
					? { sourceStartSec: Math.max(lower, Math.min(cut.sourceEndSec - 0.04, sourceSec)) }
					: { sourceEndSec: Math.min(upper, Math.max(cut.sourceStartSec + 0.04, sourceSec)) }),
			},
			document,
		);
		if (next) set({ suggestions: get().suggestions.map((item) => (item.id === id ? next : item)) });
	},

	removeCut(id) {
		if (!get().accepting) set({ suggestions: get().suggestions.filter((item) => item.id !== id) });
	},

	rejectCut(id) {
		if (get().accepting) return;
		const cut = get().suggestions.find((item) => item.id === id);
		const projectId = get().projectId;
		if (cut && projectId) rememberRejectedCut(projectId, cut);
		get().removeCut(id);
	},

	clearCuts() {
		if (get().accepting) return;
		abortActiveRun();
		set(emptyAnalysisState);
	},

	async acceptAll(ids, requestId) {
		if (get().accepting) return "conflict";
		const projectId = get().projectId;
		if (!projectId || projectId !== useProjectStore.getState().projectId) return "project-changed";
		const cuts = get().suggestions.filter((cut) => (ids ? ids.includes(cut.id) : cut.selected));
		if (cuts.length === 0) return "unchanged";
		abortActiveRun();
		set({ accepting: true });
		try {
			const result = await useProjectStore
				.getState()
				.applyDocumentPatch(projectId, (document) => applyPauseSuggestions(document, cuts), {
					createHistorySnapshot: (base) => base,
					requestId,
					maximumAttempts: requestId ? 1 : undefined,
					agentHistory: {
						kind: "apply",
						targetIds: [],
						force: false,
						planSummary: `Accept ${cuts.length} proposed cuts`,
					},
				});
			if ((result === "applied" || result === "unchanged") && get().projectId === projectId) {
				set({
					...emptyAnalysisState,
					revision: useProjectStore.getState().revision,
					suggestions: ids ? get().suggestions.filter((cut) => !ids.includes(cut.id)) : [],
					status: "ready",
				});
			}
			return result;
		} finally {
			set({ accepting: false });
		}
	},

	invalidate() {
		if (get().accepting) return;
		abortActiveRun();
		set({
			...emptyAnalysisState,
			suggestions: get().suggestions.filter((cut) => cut.kind === "agent" || cut.kind === "fix"),
		});
	},
}));

export function resetPauseAnalysisStoreForTests(): void {
	abortActiveRun();
	usePauseAnalysisStore.setState({
		projectId: null,
		revision: null,
		accepting: false,
		...emptyAnalysisState,
	});
}

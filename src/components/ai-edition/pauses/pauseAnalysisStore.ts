import { create } from "zustand";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type {
	PauseAnalysisPolicy,
	PauseSuggestion,
} from "@/lib/ai-edition/timeline/pause-analysis";
import { analyzeProjectPauses, type ProjectPauseAnalysisResult } from "./analyzeProjectPauses";

export interface SelectablePauseSuggestion extends PauseSuggestion {
	selected: boolean;
}

export type PauseAnalysisStatus = "idle" | "analyzing" | "ready" | "error";

interface PauseAnalysisState {
	projectId: string | null;
	revision: number | null;
	status: PauseAnalysisStatus;
	analysis: ProjectPauseAnalysisResult | null;
	suggestions: SelectablePauseSuggestion[];
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
	...emptyAnalysisState,

	syncDocument(projectId, revision) {
		if (get().projectId === projectId && get().revision === revision) return;
		abortActiveRun();
		set({ projectId, revision, ...emptyAnalysisState });
	},

	async analyze(document, revision, policy) {
		const projectId = document.project.id;
		get().syncDocument(projectId, revision);
		abortActiveRun();

		const runId = ++runSequence;
		const controller = new AbortController();
		activeRun = { projectId, runId, controller };
		set({ status: "analyzing", analysis: null, suggestions: [] });

		try {
			const analysis = await analyzeProjectPauses(document, policy, controller.signal);
			if (controller.signal.aborted) return;
			if (activeRun?.runId !== runId || get().projectId !== projectId) return;

			const project = useProjectStore.getState();
			if (project.projectId !== projectId || project.revision !== revision) {
				set(emptyAnalysisState);
				return;
			}

			set({
				status: "ready",
				analysis,
				suggestions: analysis.suggestions.map((suggestion) => ({
					...suggestion,
					selected: true,
				})),
			});
		} catch (error) {
			if (controller.signal.aborted) return;
			if (activeRun?.runId !== runId || get().projectId !== projectId) return;
			console.error("Pause analysis failed", error);
			set({ status: "error", analysis: null, suggestions: [] });
		} finally {
			if (activeRun?.runId === runId) activeRun = null;
		}
	},

	setSuggestions(suggestions) {
		set({ suggestions });
	},

	toggleSuggestion(suggestionId) {
		set((state) => ({
			suggestions: state.suggestions.map((suggestion) =>
				suggestion.id === suggestionId
					? { ...suggestion, selected: !suggestion.selected }
					: suggestion,
			),
		}));
	},

	invalidate() {
		abortActiveRun();
		set(emptyAnalysisState);
	},
}));

export function resetPauseAnalysisStoreForTests(): void {
	abortActiveRun();
	usePauseAnalysisStore.setState({ projectId: null, revision: null, ...emptyAnalysisState });
}

import { create } from "zustand";
import type { ExportProgress } from "@/lib/exporter";
import type { CompositorAudioMasteringResult, ExportTransactionPhase } from "@/native/contracts";

/**
 * The one running export, shared by the export dialog and the editor top bar.
 *
 * The native exporter takes a snapshot of the clips and scene when it starts, so the
 * dialog can close and the editor stay usable while the file renders. Progress and the
 * final outcome live here rather than in dialog state so that closing the dialog
 * neither cancels the export nor loses its result.
 */
export type ExportRunPhase = "idle" | "configuring" | "rendering" | "writing" | "done" | "error";

export interface ExportFailureDetails {
	phase?: ExportTransactionPhase;
	code?: string;
	retryable: boolean;
}

export interface ExportRunState {
	phase: ExportRunPhase;
	progress: ExportProgress | null;
	error: string | null;
	errorDetails: ExportFailureDetails | null;
	savedPath: string | null;
	audioMastering: CompositorAudioMasteringResult | null;
	/** Aborts the running export. Null when nothing is running. */
	cancel: (() => void) | null;
	begin: (cancel: () => void) => void;
	setPhase: (phase: ExportRunPhase) => void;
	setProgress: (progress: ExportProgress | null) => void;
	succeed: (result: {
		savedPath: string;
		audioMastering: CompositorAudioMasteringResult | null;
	}) => void;
	fail: (error: string, details: ExportFailureDetails | null) => void;
	/** Returns to idle. Ignored while an export is running; cancel it first. */
	reset: () => void;
	/** Returns to idle unconditionally: the save picker was dismissed or the run was aborted. */
	abandon: () => void;
	requestCancel: () => void;
}

const IDLE = {
	phase: "idle" as const,
	progress: null,
	error: null,
	errorDetails: null,
	savedPath: null,
	audioMastering: null,
	cancel: null,
};

export function isExportRunActive(phase: ExportRunPhase): boolean {
	return phase === "configuring" || phase === "rendering" || phase === "writing";
}

export const useExportRunStore = create<ExportRunState>((set, get) => ({
	...IDLE,
	begin: (cancel) => set({ ...IDLE, phase: "configuring", cancel }),
	setPhase: (phase) => set({ phase }),
	setProgress: (progress) => set({ progress }),
	succeed: ({ savedPath, audioMastering }) =>
		set({
			phase: "done",
			savedPath,
			audioMastering,
			cancel: null,
			error: null,
			errorDetails: null,
		}),
	fail: (error, details) =>
		set({ phase: "error", error, errorDetails: details, cancel: null, progress: null }),
	reset: () => {
		if (isExportRunActive(get().phase)) return;
		set({ ...IDLE });
	},
	abandon: () => set({ ...IDLE }),
	requestCancel: () => {
		get().cancel?.();
	},
}));

/** Percent complete for the top bar, or null before the encoder reports its first frame. */
export function exportRunPercent(state: Pick<ExportRunState, "phase" | "progress">): number | null {
	if (state.phase === "writing") return 100;
	if (state.phase !== "rendering" || !state.progress) return null;
	return Math.max(0, Math.min(100, state.progress.percentage));
}

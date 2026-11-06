import { create } from "zustand";
import type { ExportProgress } from "@/lib/exporter";
import type { CompositorAudioMasteringResult, ExportTransactionPhase } from "@/native/contracts";

export type ExportRunPhase = "idle" | "configuring" | "rendering" | "writing" | "done" | "error";
export interface ExportFailureDetails {
	phase?: ExportTransactionPhase;
	code?: string;
	retryable: boolean;
}
type Empty = {
	progress: null;
	error: null;
	errorDetails: null;
	savedPath: null;
	audioMastering: null;
	cancel: null;
};
type Active = Omit<Empty, "progress" | "cancel"> & {
	phase: "configuring" | "rendering" | "writing";
	progress: ExportProgress | null;
	cancel: () => void;
};
type Data =
	| (Empty & { phase: "idle" })
	| Active
	| (Omit<Empty, "progress" | "savedPath" | "audioMastering"> & {
			phase: "done";
			progress: ExportProgress | null;
			savedPath: string;
			audioMastering: CompositorAudioMasteringResult | null;
	  })
	| (Omit<Empty, "error" | "errorDetails"> & {
			phase: "error";
			error: string;
			errorDetails: ExportFailureDetails | null;
	  });
type Result = { savedPath: string; audioMastering: CompositorAudioMasteringResult | null };
interface Actions {
	begin(cancel: () => void): boolean;
	setPhase(phase: ExportRunPhase): void;
	setProgress(progress: ExportProgress | null): void;
	succeed(result: Result): void;
	fail(error: string, details: ExportFailureDetails | null): void;
	reset(): void;
	abandon(): void;
	requestCancel(): void;
}
export type ExportRunState = Data & Actions;
type Event =
	| { type: "begin"; cancel: () => void }
	| { type: "phase"; phase: ExportRunPhase }
	| { type: "progress"; progress: ExportProgress | null }
	| { type: "succeed"; result: Result }
	| { type: "fail"; error: string; details: ExportFailureDetails | null }
	| { type: "reset" | "abandon" | "cancel" };
const IDLE: Empty & { phase: "idle" } = {
	phase: "idle",
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
function active(data: Data): data is Active {
	return isExportRunActive(data.phase);
}

export const useExportRunStore = create<ExportRunState>((set, get) => {
	const actions: Actions = {
		begin: (cancel) => transition({ type: "begin", cancel }),
		setPhase: (phase) => {
			transition({ type: "phase", phase });
		},
		setProgress: (progress) => {
			transition({ type: "progress", progress });
		},
		succeed: (result) => {
			transition({ type: "succeed", result });
		},
		fail: (error, details) => {
			transition({ type: "fail", error, details });
		},
		reset: () => {
			transition({ type: "reset" });
		},
		abandon: () => {
			transition({ type: "abandon" });
		},
		requestCancel: () => {
			transition({ type: "cancel" });
		},
	};
	function transition(event: Event): boolean {
		const state = get();
		let next: Data;
		const reject = () => {
			console.warn("[export-run] Illegal transition", {
				phase: state.phase,
				event: event.type,
				...(event.type === "phase" ? { requested: event.phase } : {}),
			});
			return false;
		};
		switch (event.type) {
			case "begin":
				if (active(state)) return reject();
				next = { ...IDLE, phase: "configuring", cancel: event.cancel };
				break;
			case "phase":
				if (
					!active(state) ||
					!(
						event.phase === "configuring" ||
						event.phase === "rendering" ||
						event.phase === "writing"
					)
				)
					return reject();
				if (
					["configuring", "rendering", "writing"].indexOf(event.phase) <
					["configuring", "rendering", "writing"].indexOf(state.phase)
				)
					return reject();
				next = { ...state, phase: event.phase };
				break;
			case "progress":
				if (!active(state)) return reject();
				next = { ...state, progress: event.progress };
				break;
			case "succeed":
				if (!active(state)) return reject();
				next = { ...IDLE, phase: "done", progress: state.progress, ...event.result };
				break;
			case "fail":
				next = { ...IDLE, phase: "error", error: event.error, errorDetails: event.details };
				break;
			case "reset":
				if (active(state)) return reject();
				next = IDLE;
				break;
			case "abandon":
				next = IDLE;
				break;
			case "cancel":
				if (!active(state)) return reject();
				state.cancel();
				return true;
		}
		set({ ...next, ...actions }, true);
		return true;
	}
	return { ...IDLE, ...actions };
});

export function exportRunPercent(state: Pick<ExportRunState, "phase" | "progress">): number | null {
	if (state.phase === "writing") return 100;
	if (state.phase !== "rendering" || !state.progress) return null;
	return Math.max(0, Math.min(100, state.progress.percentage));
}

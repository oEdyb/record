import type { AxcutDocument } from "../schema";
import type { PauseAnalysisPolicy, PauseSuggestion } from "../timeline/pause-analysis";

export interface AgentPauseAnalysisReport {
	status: "analyzing" | "ready" | "error";
	revision: string;
	policy: PauseAnalysisPolicy;
	analyzedClipCount: number;
	missingTranscript: boolean;
	missingMicrophone: boolean;
	missingSpeechActivity: boolean;
	usedMixedAudio: boolean;
	suggestions: PauseSuggestion[];
	error: string | null;
}

type Analyzer = (
	document: AxcutDocument,
	policy: PauseAnalysisPolicy,
) => Promise<Omit<AgentPauseAnalysisReport, "status" | "revision" | "policy" | "error">>;

interface Run {
	key: string;
	report: AgentPauseAnalysisReport;
}

let current: Run | null = null;

function runKey(projectId: string, revision: string, policy: PauseAnalysisPolicy): string {
	return `${projectId}:${revision}:${JSON.stringify(policy)}`;
}

/**
 * One cached analysis per project revision and policy. The first call starts it and
 * returns "analyzing"; later identical calls return the same run's current state, so a
 * CLI can poll without restarting the work.
 */
export function requestAgentPauseAnalysis(
	document: AxcutDocument,
	revision: string,
	policy: PauseAnalysisPolicy,
	analyze: Analyzer,
): AgentPauseAnalysisReport {
	const key = runKey(document.project.id, revision, policy);
	if (current?.key === key) return current.report;
	const run: Run = {
		key,
		report: {
			status: "analyzing",
			revision,
			policy,
			analyzedClipCount: 0,
			missingTranscript: false,
			missingMicrophone: false,
			missingSpeechActivity: false,
			usedMixedAudio: false,
			suggestions: [],
			error: null,
		},
	};
	current = run;
	analyze(document, policy).then(
		(result) => {
			if (current !== run) return;
			run.report = { ...run.report, ...result, status: "ready" };
		},
		(error: unknown) => {
			if (current !== run) return;
			run.report = {
				...run.report,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		},
	);
	return run.report;
}

export function resetAgentPauseAnalysis(): void {
	current = null;
}

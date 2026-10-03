import type { AxcutDocument } from "../schema";
import type { EdgeSilencePolicy, EdgeSilenceSuggestion } from "../timeline/edge-silence";

export interface AgentEdgeAnalysisReport {
	status: "analyzing" | "ready" | "error";
	revision: string;
	policy: EdgeSilencePolicy;
	analyzedClipCount: number;
	missingSpeechActivity: string[];
	missingMicrophone: string[];
	suggestions: EdgeSilenceSuggestion[];
	existingEdgeTrimIds: string[];
	error: string | null;
}

type Analyzer = (
	document: AxcutDocument,
	policy: EdgeSilencePolicy,
) => Promise<Omit<AgentEdgeAnalysisReport, "status" | "revision" | "policy" | "error">>;

interface Run {
	key: string;
	report: AgentEdgeAnalysisReport;
}

let current: Run | null = null;

/**
 * One cached edge analysis per project revision and policy, so a CLI can poll
 * until the speech envelopes are loaded without restarting the work.
 */
export function requestAgentEdgeAnalysis(
	document: AxcutDocument,
	revision: string,
	policy: EdgeSilencePolicy,
	analyze: Analyzer,
): AgentEdgeAnalysisReport {
	const key = `${document.project.id}:${revision}:${JSON.stringify(policy)}`;
	if (current?.key === key) return current.report;
	const run: Run = {
		key,
		report: {
			status: "analyzing",
			revision,
			policy,
			analyzedClipCount: 0,
			missingSpeechActivity: [],
			missingMicrophone: [],
			suggestions: [],
			existingEdgeTrimIds: [],
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

export function resetAgentEdgeAnalysis(): void {
	current = null;
}

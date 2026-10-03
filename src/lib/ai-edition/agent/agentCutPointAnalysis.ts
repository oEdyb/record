import type { AxcutDocument } from "../schema";
import type { CutPointPolicy } from "../timeline/cut-point";

export interface AgentCutPointRequest {
	clipId: string;
	timeSec: number;
	edge: "out" | "in";
	policy: CutPointPolicy;
}

export interface AgentCutPointReport<T = unknown> {
	status: "analyzing" | "ready" | "error";
	revision: string;
	request: AgentCutPointRequest;
	result: T | null;
	error: string | null;
}

type Analyzer<T> = (document: AxcutDocument, request: AgentCutPointRequest) => Promise<T>;

interface Run {
	key: string;
	report: AgentCutPointReport;
}

let current: Run | null = null;

/**
 * One cached cut-point analysis per project revision and request, so the CLI can
 * poll while the microphone envelope and speech activity load for a long recording.
 */
export function requestAgentCutPoint<T>(
	document: AxcutDocument,
	revision: string,
	request: AgentCutPointRequest,
	analyze: Analyzer<T>,
): AgentCutPointReport<T> {
	const key = `${document.project.id}:${revision}:${JSON.stringify(request)}`;
	if (current?.key === key) return current.report as AgentCutPointReport<T>;
	const run: Run = {
		key,
		report: { status: "analyzing", revision, request, result: null, error: null },
	};
	current = run;
	analyze(document, request).then(
		(result) => {
			if (current !== run) return;
			run.report = { ...run.report, result, status: "ready" };
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
	return run.report as AgentCutPointReport<T>;
}

export function resetAgentCutPoint(): void {
	current = null;
}

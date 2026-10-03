import type { CheckProgress } from "@/components/ai-edition/pauses/analyzeProjectChecks";
import type { CheckRequest, CheckResult } from "../checks";
import type { AxcutDocument } from "../schema";

export interface CheckRun {
	status: "analyzing" | "ready" | "error";
	revision: string;
	result: CheckResult | null;
	audio: { ready: number; pending: number };
	timings: { elapsedMs: number; peaksMs: number; speechMs: number };
	error: string | null;
}
export function createCheckAnalysisCache() {
	const runs = new Map<string, { run: CheckRun; abort: AbortController }>();
	return (
		document: AxcutDocument,
		revision: string,
		request: CheckRequest,
		files: Readonly<Record<string, boolean | null>>,
		analyze: (
			progress: (value: CheckProgress) => void,
			signal: AbortSignal,
		) => Promise<CheckResult>,
	): CheckRun => {
		const key = JSON.stringify([
			document,
			revision,
			request.rule,
			request.range,
			!!request.deep,
			Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
		]);
		const existing = runs.get(key);
		if (existing) return existing.run;
		const run: CheckRun = {
			status: "analyzing",
			revision,
			result: null,
			audio: { ready: 0, pending: 0 },
			timings: { elapsedMs: 0, peaksMs: 0, speechMs: 0 },
			error: null,
		};
		const abort = new AbortController();
		runs.set(key, { run, abort });
		while (runs.size > 4) {
			const first = runs.keys().next().value;
			if (first !== undefined) {
				runs.get(first)?.abort.abort();
				runs.delete(first);
			}
		}
		const fail = (error: unknown) => {
			run.status = "error";
			run.error = (error instanceof Error ? error.message : String(error)).slice(0, 512);
		};
		try {
			void analyze((value) => {
				Object.assign(run, value);
				run.status = value.audio.pending ? "analyzing" : "ready";
			}, abort.signal).then((result) => {
				run.result = result;
				run.status = "ready";
			}, fail);
		} catch (error) {
			fail(error);
		}
		return run;
	};
}
export const requestAgentChecks = createCheckAnalysisCache();

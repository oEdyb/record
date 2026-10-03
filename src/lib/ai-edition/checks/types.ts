import type { AgentEditOperation } from "../../../../electron/ai-edition/agentEditPlan";
import type { ResolvedEdit, Span } from "./context";

export type Severity = "error" | "warning" | "info";
export interface Finding {
	rule: string;
	severity: Severity;
	at: number;
	span: Span;
	clip: string | null;
	message: string;
	fix: AgentEditOperation[] | null;
	cutEvidence?: {
		method: "mic-level" | "speech" | "transcript";
		disagreementSec: number;
	};
}
export interface RuleResult {
	findings: Finding[];
	notes?: string[];
}
export interface CheckRule {
	id: string;
	severity: Severity;
	describe: string;
	fix?: string;
	/** The rule reads microphone peaks; the analyzer loads audio for it and pages per asset. */
	audio?: boolean;
	run(context: ResolvedEdit): RuleResult;
}
export function finding(
	rule: Pick<CheckRule, "id" | "severity">,
	span: Span,
	clip: string | null,
	message: string,
	fix: Finding["fix"] = null,
): Finding {
	return { rule: rule.id, severity: rule.severity, at: span.startSec, span, clip, message, fix };
}

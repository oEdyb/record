import type { EdgeSilencePolicy } from "../timeline/edge-silence";
import type { PauseAnalysisPolicy } from "../timeline/pause-analysis";
import type { AgentCutPointRequest } from "./agentCutPointAnalysis";
import type { AgentTransportStep } from "./agentTransport";

export const AGENT_SESSION_REQUEST = "klippt:agent-session-request";
export const AGENT_SESSION_REPLY = "klippt:agent-session-reply";

export interface AgentSessionMessage {
	id: string;
	action:
		| "stage"
		| "staged"
		| "accept"
		| "reject"
		| "inspect"
		| "capabilities"
		| "presets"
		| "direction-observations"
		| "activate"
		| "apply"
		| "transcribe"
		| "pauses"
		| "edges"
		| "cutpoint"
		| "state"
		| "check"
		| "transport"
		| "open";
	projectId?: string;
	stagedCuts?: { operations: unknown[]; planId: string };
	cutIds?: string[];
	cutOffset?: number;
	mutationRequestId?: string;
	directionSettings?: import("zod").z.infer<
		typeof import("./automaticSettings").agentAutomaticSettingsSchema
	>;
	documentKey?: string;
	document?: unknown;
	guard?: import("@/native/contracts").AiEditionWriteGuard;
	pausePolicy?: PauseAnalysisPolicy;
	edgePolicy?: EdgeSilencePolicy;
	editState?: import("./effectiveState").StateRequest;
	editCheck?: import("../checks").CheckRequest & {
		files: Record<string, boolean | null>;
		documentKey: string;
	};
	cutPoint?: AgentCutPointRequest;
	transport?: { runId: string; steps: AgentTransportStep[] };
}

export interface AgentSessionReply {
	id: string;
	status: "completed" | "failed";
	data?: unknown;
	error?: { code: string; message: string };
}

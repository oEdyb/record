import { z } from "zod";
import type { AgentEdgeAnalysisReport } from "../../src/lib/ai-edition/agent/agentEdgeAnalysis";
import {
	DEFAULT_EDGE_SILENCE_POLICY,
	type EdgeSilencePolicy,
} from "../../src/lib/ai-edition/timeline/edge-silence";

const seconds = z.number().finite().min(0).max(10);

export const edgePolicySchema = z.strictObject({
	padBeforeSec: seconds,
	padAfterSec: seconds,
	sensitivity: z.number().finite().min(0).max(1),
	minimumCutSec: seconds,
	maximumClipSec: z.number().finite().min(1).max(7200),
	minimumGapSec: seconds,
});

export const edgesCommandInput = z.strictObject({
	project_id: z.string().min(1).max(256),
	pad_before: seconds.default(DEFAULT_EDGE_SILENCE_POLICY.padBeforeSec),
	pad_after: seconds.default(DEFAULT_EDGE_SILENCE_POLICY.padAfterSec),
	max_clip_sec: z
		.number()
		.finite()
		.min(1)
		.max(7200)
		.default(DEFAULT_EDGE_SILENCE_POLICY.maximumClipSec),
	min_gap: seconds.default(DEFAULT_EDGE_SILENCE_POLICY.minimumGapSec),
	remove: z.enum(["true", "false"]).default("false"),
	// Phase 4: footage removal stages into the proposal lane by default;
	// --accept "<reason>" applies directly (the reason is mandatory).
	accept: z.string().trim().min(1).max(256).optional(),
	request_id: z.string().min(1).max(128).optional(),
});

export type EdgesCommandInput = z.infer<typeof edgesCommandInput>;

export function buildEdgePolicy(input: EdgesCommandInput): EdgeSilencePolicy {
	return {
		...DEFAULT_EDGE_SILENCE_POLICY,
		padBeforeSec: input.pad_before,
		padAfterSec: input.pad_after,
		maximumClipSec: input.max_clip_sec,
		minimumGapSec: input.min_gap,
	};
}

export const edgesBrokerInput = z.strictObject({
	projectId: z.string().min(1).max(256),
	policy: edgePolicySchema,
});

export interface EdgeOperation {
	type: "addTrim" | "removeTrims";
	args: Record<string, unknown>;
}

export function formatEdgeReport(report: AgentEdgeAnalysisReport) {
	const operations: EdgeOperation[] = report.suggestions.map((suggestion) => ({
		type: "addTrim",
		args: {
			clipId: suggestion.clipId,
			startSec: suggestion.sourceStartSec,
			endSec: suggestion.sourceEndSec,
			reason: suggestion.reason,
		},
	}));
	const removeOperations: EdgeOperation[] =
		report.existingEdgeTrimIds.length > 0
			? [{ type: "removeTrims", args: { trimRangeIds: report.existingEdgeTrimIds } }]
			: [];
	return {
		status: report.status,
		error: report.error,
		revision: report.revision,
		policy: report.policy,
		analyzed_clip_count: report.analyzedClipCount,
		missing_speech_activity: report.missingSpeechActivity,
		missing_microphone: report.missingMicrophone,
		totals: {
			suggestions: report.suggestions.length,
			gaps: report.suggestions.filter((suggestion) => suggestion.edge === "gap").length,
			saved_seconds: Number(
				report.suggestions.reduce((sum, suggestion) => sum + suggestion.savedSec, 0).toFixed(3),
			),
			existing_edge_trims: report.existingEdgeTrimIds.length,
		},
		suggestions: report.suggestions.map((suggestion) => ({
			clip_id: suggestion.clipId,
			edge: suggestion.edge,
			source_start: suggestion.sourceStartSec,
			source_end: suggestion.sourceEndSec,
			saved_seconds: Number(suggestion.savedSec.toFixed(3)),
		})),
		time_bases: {
			source_start: "source_seconds",
			source_end: "source_seconds",
			saved_seconds: "duration_seconds",
			"operations[].args.startSec/endSec": "source_seconds",
		},
		operations,
		remove_operations: removeOperations,
	};
}

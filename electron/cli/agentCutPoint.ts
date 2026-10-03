import { z } from "zod";
import type { CutPointAnalysis } from "../../src/components/ai-edition/pauses/analyzeCutPoint";
import type { AgentCutPointReport } from "../../src/lib/ai-edition/agent/agentCutPointAnalysis";
import {
	type CutPointPolicy,
	DEFAULT_CUT_POINT_POLICY,
} from "../../src/lib/ai-edition/timeline/cut-point";
import { type ResolvedInstant, timeInputObjectSchema, timeInputSchema } from "./agentTimeBase";
import type { ProposalOperation } from "./agentWriteFlow";

const seconds = z.number().finite().min(0).max(10);

export const cutPointPolicySchema = z.strictObject({
	padBeforeSec: seconds,
	padAfterSec: seconds,
	sensitivity: z.number().finite().min(0).max(1),
	sentenceGapSec: seconds,
});

export const cutPointCommandInput = z.strictObject({
	project_id: z.string().min(1).max(256),
	clip: z.string().min(1).max(256),
	// Compatibility: a bare number stays SOURCE seconds (the documented phase-2
	// meaning). Suffixed forms add the other clocks: 103e/1:43 edited, 125.3r raw.
	time: timeInputSchema("source"),
	edge: z.enum(["out", "in"]),
	pad_before: seconds.default(DEFAULT_CUT_POINT_POLICY.padBeforeSec),
	pad_after: seconds.default(DEFAULT_CUT_POINT_POLICY.padAfterSec),
	sentence_gap: seconds.default(DEFAULT_CUT_POINT_POLICY.sentenceGapSec),
	// Phase 4: a chosen cut stages the footage it removes into the proposal
	// lane by default; --accept "<reason>" applies the trim directly.
	accept: z.string().trim().min(1).max(256).optional(),
	request_id: z.string().min(1).max(128).optional(),
});

export type CutPointCommandInput = z.infer<typeof cutPointCommandInput>;

export function buildCutPointPolicy(input: CutPointCommandInput): CutPointPolicy {
	return {
		...DEFAULT_CUT_POINT_POLICY,
		padBeforeSec: input.pad_before,
		padAfterSec: input.pad_after,
		sentenceGapSec: input.sentence_gap,
	};
}

export const cutPointBrokerInput = z
	.strictObject({
		projectId: z.string().min(1).max(256),
		clipId: z.string().min(1).max(256),
		/** Legacy source-seconds form; `time` carries the base explicitly. */
		timeSec: z.number().finite().min(0).optional(),
		time: timeInputObjectSchema.optional(),
		edge: z.enum(["out", "in"]),
		policy: cutPointPolicySchema,
	})
	.refine((input) => input.timeSec !== undefined || input.time !== undefined, {
		message: "time is required",
	});

const round = (value: number) => Number(value.toFixed(3));

/**
 * The addTrim a chosen cut implies: the footage on the wrong side of the cut,
 * matching the lane's minimum 0.04 s trim. cut_sec is already clamped to the
 * clip bounds by planCutPoint. Returns null when nothing would be removed.
 */
export function cutPointRemovalOperation(
	cut: { clipId: string; edge: "out" | "in"; cutSec: number },
	clip: { sourceStartSec: number; sourceEndSec: number },
): ProposalOperation | null {
	const startSec = cut.edge === "out" ? cut.cutSec : clip.sourceStartSec;
	const endSec = cut.edge === "out" ? clip.sourceEndSec : cut.cutSec;
	if (endSec - startSec < 0.04 - 1e-9) return null;
	return {
		type: "addTrim",
		args: {
			clipId: cut.clipId,
			startSec: round(startSec),
			endSec: round(endSec),
			reason: `Cut point ${cut.edge} at ${round(cut.cutSec)}s`,
		},
	};
}

export function formatCutPointReport(
	report: AgentCutPointReport<CutPointAnalysis>,
	resolution?: ResolvedInstant,
) {
	const result = report.result;
	const candidate = (c: CutPointAnalysis["chosen"]) =>
		c
			? {
					before: c.before,
					after: c.after,
					transcript_sec: round(c.transcriptSec),
					audio_sec: round(c.audioSec),
					method: c.method,
					cut_sec: round(c.cutSec),
					distance_sec: round(c.distanceSec),
				}
			: null;
	return {
		status: report.status,
		error: report.error,
		revision: report.revision,
		clip_id: report.request.clipId,
		requested_sec: report.request.timeSec,
		edge: report.request.edge,
		policy: report.request.policy,
		time_base: "seconds in the source asset; use cut_sec with setTrim or addTrim",
		...(resolution ? { requested_time: resolution } : {}),
		missing_microphone: result?.missingMicrophone ?? null,
		missing_speech_activity: result?.missingSpeechActivity ?? null,
		chosen: result ? candidate(result.chosen) : null,
		alternatives: result ? result.alternatives.map(candidate) : [],
	};
}

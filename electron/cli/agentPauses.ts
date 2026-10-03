import { z } from "zod";
import type { AgentPauseAnalysisReport } from "../../src/lib/ai-edition/agent/agentPauseAnalysis";
import {
	DEFAULT_PAUSE_POLICY,
	PAUSE_PRESETS,
	type PauseAnalysisPolicy,
	type PausePresetId,
} from "../../src/lib/ai-edition/timeline/pause-analysis";

const seconds = z.number().finite().min(0).max(60);

export const pausePolicySchema = z.strictObject({
	mode: z.enum(["speech", "audio-level"]),
	minimumPauseSec: seconds,
	shortenedPauseSec: seconds,
	keepBeforeSec: seconds,
	keepAfterSec: seconds,
	minimumKeptFragmentSec: seconds,
	sensitivity: z.number().finite().min(0).max(1),
	manualThresholdDb: z.number().finite().nullable(),
	includeNonSpeechEvents: z.boolean(),
	protectSystemAudio: z.boolean(),
	protectScreenActivity: z.boolean(),
	transitionMs: z.number().finite().min(0).max(1000),
});

export const pausesCommandInput = z.strictObject({
	project_id: z.string().min(1).max(256),
	preset: z.enum(["natural", "balanced", "tight"]).default("balanced"),
	mode: z.enum(["speech", "audio-level"]).optional(),
	min_pause: seconds.optional(),
	shortened: seconds.optional(),
	keep_before: seconds.optional(),
	keep_after: seconds.optional(),
	protect_system_audio: z.enum(["true", "false"]).optional(),
	protect_screen_activity: z.enum(["true", "false"]).optional(),
	ignore_non_speech: z.enum(["true", "false"]).optional(),
	clips: z.string().min(1).optional(),
	offset: z.number().int().min(0).max(1_000_000).default(0),
	limit: z.number().int().min(1).max(500).default(200),
	// Phase 4: ready suggestions stage into the proposal lane by default;
	// --accept "<reason>" applies the returned page directly.
	accept: z.string().trim().min(1).max(256).optional(),
	request_id: z.string().min(1).max(128).optional(),
});

export type PausesCommandInput = z.infer<typeof pausesCommandInput>;

export function buildPausePolicy(input: PausesCommandInput): PauseAnalysisPolicy {
	const preset = PAUSE_PRESETS[input.preset as PausePresetId];
	return {
		...DEFAULT_PAUSE_POLICY,
		...preset,
		...(input.mode ? { mode: input.mode } : {}),
		...(input.min_pause !== undefined ? { minimumPauseSec: input.min_pause } : {}),
		...(input.shortened !== undefined ? { shortenedPauseSec: input.shortened } : {}),
		...(input.keep_before !== undefined ? { keepBeforeSec: input.keep_before } : {}),
		...(input.keep_after !== undefined ? { keepAfterSec: input.keep_after } : {}),
		...(input.protect_system_audio
			? { protectSystemAudio: input.protect_system_audio === "true" }
			: {}),
		...(input.protect_screen_activity
			? { protectScreenActivity: input.protect_screen_activity === "true" }
			: {}),
		...(input.ignore_non_speech
			? { includeNonSpeechEvents: input.ignore_non_speech === "true" }
			: {}),
	};
}

export const pausesBrokerInput = z.strictObject({
	projectId: z.string().min(1).max(256),
	policy: pausePolicySchema,
	clips: z.string().min(1).optional(),
	offset: z.number().int().min(0).max(1_000_000),
	limit: z.number().int().min(1).max(500),
});

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Page the suggestions and hand back ready-to-plan addTrim operations for that page. */
export function formatPauseReport(
	report: AgentPauseAnalysisReport,
	offset: number,
	limit: number,
	clips?: string,
) {
	const wanted = clips ? new Set(clips.split(",").map((id) => id.trim())) : null;
	const suggestions = wanted
		? report.suggestions.filter((s) => wanted.has(s.clipId))
		: report.suggestions;
	const page = suggestions.slice(offset, offset + limit);
	return {
		status: report.status,
		error: report.error,
		revision: report.revision,
		policy: report.policy,
		analyzed_clip_count: report.analyzedClipCount,
		evidence: {
			missing_transcript: report.missingTranscript,
			missing_microphone: report.missingMicrophone,
			missing_speech_activity: report.missingSpeechActivity,
			used_mixed_audio: report.usedMixedAudio,
		},
		totals: {
			suggestions: suggestions.length,
			saved_seconds: round(suggestions.reduce((sum, s) => sum + s.savedSec, 0)),
		},
		suggestions: page.map((s) => ({
			id: s.id,
			kind: s.kind,
			clip_id: s.clipId,
			source_start: round(s.sourceStartSec),
			source_end: round(s.sourceEndSec),
			timeline_start: round(s.timelineStartSec),
			timeline_end: round(s.timelineEndSec),
			saved_seconds: round(s.savedSec),
		})),
		time_bases: {
			source_start: "source_seconds",
			source_end: "source_seconds",
			timeline_start: "raw_virtual_seconds",
			timeline_end: "raw_virtual_seconds",
			saved_seconds: "duration_seconds",
			"operations[].args.startSec/endSec": "source_seconds",
		},
		operations: page.map((s) => ({
			type: "addTrim" as const,
			args: {
				clipId: s.clipId,
				startSec: round(s.sourceStartSec),
				endSec: round(s.sourceEndSec),
				// The lane vocabulary (cutsFromOperations) classifies this exact
				// reason as kind "pause" with origin "Shorten Pauses", matching the
				// editor's own pause staging.
				reason: "Shortened pause",
			},
		})),
		offset,
		next_offset: offset + limit < suggestions.length ? offset + limit : null,
		next_actions:
			report.status === "analyzing"
				? [{ command: "Repeat the same pauses command until status is ready" }]
				: report.status === "ready"
					? [
							{
								command:
									'The CLI stages the returned page into the proposal lane by default; review with klippt agent staged --project_id <id>, then accept or reject. --accept "<reason>" applies directly.',
							},
						]
					: [],
	};
}

export type EvidenceRequirement =
	| "changed_span"
	| "boundaries"
	| "live_seek"
	| "live_playback"
	| "span_export"
	| "isolated_audio"
	| "listening";
export type Capability = "editor" | "fresh_frames" | "saved_render" | "audio_decode";
export interface CommandPolicy {
	effects: readonly string[];
	requires: readonly Capability[];
	verification: readonly EvidenceRequirement[];
}

const visual: EvidenceRequirement[] = ["changed_span", "boundaries"];
const motion: EvidenceRequirement[] = [...visual, "live_seek", "live_playback", "span_export"];
const speech: EvidenceRequirement[] = [...motion, "isolated_audio", "listening"];
export const commandPolicies = {
	discovery: { effects: ["read_contract"], requires: [], verification: [] },
	saved: { effects: ["read_saved_project"], requires: [], verification: [] },
	live: { effects: ["read_live_project"], requires: ["editor"], verification: [] },
	analysis: { effects: ["analysis_cache"], requires: ["editor"], verification: [] },
	render: { effects: ["write_artifacts"], requires: ["saved_render"], verification: [] },
	shot: { effects: ["write_artifacts", "seek_when_live"], requires: ["editor"], verification: [] },
	verify: { effects: ["write_artifacts"], requires: ["editor", "audio_decode"], verification: [] },
	plan: {
		effects: ["prepare_candidate", "stage_when_requested"],
		requires: ["editor"],
		verification: [],
	},
	proposal: {
		effects: ["stage_proposals", "commit_when_accepted"],
		requires: ["editor"],
		verification: speech,
	},
	reject: {
		effects: ["proposal_state", "rejection_memory"],
		requires: ["editor"],
		verification: [],
	},
	visual: { effects: ["commit_document"], requires: ["editor"], verification: visual },
	motion: { effects: ["commit_document"], requires: ["editor"], verification: motion },
	speech: { effects: ["commit_document"], requires: ["editor"], verification: speech },
	general: { effects: ["commit_document"], requires: ["editor"], verification: speech },
	settings: {
		effects: ["read_settings", "commit_when_set"],
		requires: ["editor"],
		verification: motion,
	},
	preset: {
		effects: ["read_library", "write_library", "commit_when_applied"],
		requires: ["editor"],
		verification: motion,
	},
	clone: { effects: ["write_new_project"], requires: [], verification: [] },
	open: { effects: ["switch_project"], requires: ["editor"], verification: [] },
	transport: { effects: ["seek_play_pause_ui"], requires: ["editor"], verification: [] },
} satisfies Record<string, CommandPolicy>;

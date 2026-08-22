import {
	DEFAULT_PAUSE_POLICY,
	PAUSE_PRESETS,
	type PauseAnalysisPolicy,
	type PausePresetId,
} from "@/lib/ai-edition/timeline/pause-analysis";

const SETTINGS_KEY = "klippt.pause-analysis:v1";
const PRESETS_KEY = "klippt.pause-presets:v1";

export interface SavedPausePreset {
	id: string;
	name: string;
	policy: PauseAnalysisPolicy;
}

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function normalizePolicy(value: unknown): PauseAnalysisPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_PAUSE_POLICY;
	const raw = value as Partial<PauseAnalysisPolicy>;
	const number = (candidate: unknown, fallback: number, minimum: number, maximum: number) =>
		typeof candidate === "number" && Number.isFinite(candidate)
			? Math.min(maximum, Math.max(minimum, candidate))
			: fallback;
	return {
		mode: raw.mode === "audio-level" ? "audio-level" : "speech",
		minimumPauseSec: number(raw.minimumPauseSec, DEFAULT_PAUSE_POLICY.minimumPauseSec, 0.25, 10),
		shortenedPauseSec: number(
			raw.shortenedPauseSec,
			DEFAULT_PAUSE_POLICY.shortenedPauseSec,
			0.05,
			3,
		),
		keepBeforeSec: number(raw.keepBeforeSec, DEFAULT_PAUSE_POLICY.keepBeforeSec, 0, 1),
		keepAfterSec: number(raw.keepAfterSec, DEFAULT_PAUSE_POLICY.keepAfterSec, 0, 1),
		minimumKeptFragmentSec: number(
			raw.minimumKeptFragmentSec,
			DEFAULT_PAUSE_POLICY.minimumKeptFragmentSec,
			0.1,
			2,
		),
		sensitivity: number(raw.sensitivity, DEFAULT_PAUSE_POLICY.sensitivity, 0, 1),
		manualThresholdDb:
			raw.manualThresholdDb === null ? null : number(raw.manualThresholdDb, -38, -70, -10),
		protectSystemAudio:
			typeof raw.protectSystemAudio === "boolean"
				? raw.protectSystemAudio
				: DEFAULT_PAUSE_POLICY.protectSystemAudio,
		protectScreenActivity:
			typeof raw.protectScreenActivity === "boolean"
				? raw.protectScreenActivity
				: DEFAULT_PAUSE_POLICY.protectScreenActivity,
		transitionMs: number(raw.transitionMs, DEFAULT_PAUSE_POLICY.transitionMs, 0, 50),
	};
}

export function loadPausePolicy(): PauseAnalysisPolicy {
	try {
		const raw = storage()?.getItem(SETTINGS_KEY);
		return raw ? normalizePolicy(JSON.parse(raw)) : DEFAULT_PAUSE_POLICY;
	} catch {
		return DEFAULT_PAUSE_POLICY;
	}
}

export function savePausePolicy(policy: PauseAnalysisPolicy): void {
	storage()?.setItem(SETTINGS_KEY, JSON.stringify(normalizePolicy(policy)));
}

export function policyForBuiltInPausePreset(
	id: PausePresetId,
	current: PauseAnalysisPolicy,
): PauseAnalysisPolicy {
	return { ...current, ...PAUSE_PRESETS[id] };
}

export function loadSavedPausePresets(): SavedPausePreset[] {
	try {
		const raw = storage()?.getItem(PRESETS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item): SavedPausePreset[] => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return [];
			const candidate = item as Partial<SavedPausePreset>;
			if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
			return [
				{
					id: candidate.id,
					name: candidate.name.slice(0, 60),
					policy: normalizePolicy(candidate.policy),
				},
			];
		});
	} catch {
		return [];
	}
}

export function savePausePreset(name: string, policy: PauseAnalysisPolicy): SavedPausePreset[] {
	const trimmed = name.trim();
	if (!trimmed) return loadSavedPausePresets();
	const presets = loadSavedPausePresets();
	const next = [
		...presets.filter((preset) => preset.name.toLocaleLowerCase() !== trimmed.toLocaleLowerCase()),
		{ id: `pause-preset-${Date.now()}`, name: trimmed, policy: normalizePolicy(policy) },
	];
	storage()?.setItem(PRESETS_KEY, JSON.stringify(next));
	return next;
}

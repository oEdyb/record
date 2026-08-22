import type { MotionSpeed } from "@/lib/zoomMath/motionCurve";
import { isMotionSpeed } from "@/lib/zoomMath/motionCurve";
import type { AxcutDocument } from "../schema";
import {
	type AutomaticDirectionPolicy,
	DEFAULT_AUTOMATIC_DIRECTION_POLICY,
} from "./automatic-direction";

const PROJECT_SETTINGS_KEY = "automaticDirectionSettings";
const PRESET_STORAGE_KEY = "klippt.automatic-direction-presets:v1";
const SETTINGS_VERSION = 1;

export const DEFAULT_AUTOMATIC_DIRECTION_PRESET_ID = "balanced";

export interface StoredAutomaticDirectionSettings {
	version: 1;
	presetId: string | null;
	policy: AutomaticDirectionPolicy;
}

export interface AutomaticDirectionPreset {
	id: string;
	name: string;
	overrides: Record<string, unknown>;
}

export interface AutomaticDirectionNumberControl {
	path: string;
	group: string;
	label: string;
	description: string;
	min: number;
	max: number;
	step: number;
	decimals: number;
	suffix: string;
	primary: boolean;
}

interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

type NumberRange = Pick<
	AutomaticDirectionNumberControl,
	"min" | "max" | "step" | "decimals" | "suffix"
>;

const PRIMARY_CONTROLS: Record<
	string,
	Pick<AutomaticDirectionNumberControl, "label" | "description">
> = {
	maximumScreenScale: {
		label: "Max Zoom",
		description: "The deepest crop automatic Screen Zoom can create.",
	},
	"screen.maxZoomsPerMinute": {
		label: "Screen Zooms",
		description: "Maximum separate screen direction sequences per minute.",
	},
	"camera.maxTotalDirectionPerMinute": {
		label: "Total edits",
		description: "Shared screen and camera direction budget per minute.",
	},
	"screen.defaultZoomDurationMs": {
		label: "Zoom duration",
		description: "Preferred duration for a normal automatic Screen Zoom.",
	},
	"typing.typingIdleGapMs": {
		label: "Typing idle time",
		description: "End a typing passage after this long without a key event.",
	},
	"camera.cursorQuietMs": {
		label: "Camera quiet time",
		description: "Wait this long after screen activity before Camera Emphasis.",
	},
	"camera.minimumDurationMs": {
		label: "Camera duration",
		description: "Shortest Camera Emphasis region the planner can create.",
	},
	"camera.cameraScale": {
		label: "Camera emphasis size",
		description: "How much the camera grows during Camera Emphasis.",
	},
};

const GROUP_LABELS: Record<string, string> = {
	maximumScreenScale: "General",
	screen: "Screen intent",
	connectedClicks: "Clicks, drags, and movement",
	typing: "Typing",
	microphoneActivity: "Microphone detection",
	camera: "Camera Emphasis",
};

// These values control the safety solver itself. They are implementation
// invariants, not creative preferences, so the editor must not weaken them.
const LOCKED_CONTROL_PATHS = new Set([
	"connectedClicks.safetyFramesPerSecond",
	"connectedClicks.scaleSearchIterations",
]);

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function automaticDirectionNumberRange(path: string): NumberRange {
	if (path === "maximumScreenScale") {
		return { min: 1.05, max: 5, step: 0.05, decimals: 2, suffix: "×" };
	}
	if (path === "camera.cameraScale") {
		return { min: 1, max: 1.6, step: 0.05, decimals: 2, suffix: "×" };
	}
	if (path.endsWith("Scale") || path.endsWith(".scale")) {
		return { min: 1, max: 5, step: 0.05, decimals: 2, suffix: "×" };
	}
	if (path.endsWith("MotionSpeed") || path.includes("panMotionSpeeds.")) {
		return { min: 0.5, max: 2, step: 0.25, decimals: 2, suffix: "×" };
	}
	if (
		path === "microphoneActivity.frameMs" ||
		path === "camera.motionBucketMs" ||
		path === "typing.anchorIntervalMs" ||
		path.endsWith("ScoreUnitMs")
	) {
		return { min: 10, max: 60_000, step: 10, decimals: 0, suffix: " ms" };
	}
	if (path.endsWith("Ms")) {
		return { min: 0, max: 60_000, step: 50, decimals: 0, suffix: " ms" };
	}
	if (path.includes("PerMinute")) {
		return { min: 1, max: 20, step: 1, decimals: 0, suffix: "/min" };
	}
	if (path.toLowerCase().includes("quantile")) {
		return { min: 0, max: 1, step: 0.01, decimals: 2, suffix: "" };
	}
	if (path === "screen.clickEnvelopeOutlierTrimRatio") {
		return { min: 0, max: 0.25, step: 0.005, decimals: 3, suffix: "" };
	}
	if (path === "connectedClicks.safeInset") {
		return { min: 0, max: 0.5, step: 0.01, decimals: 2, suffix: "" };
	}
	if (
		path.endsWith("Count") ||
		path.endsWith("Iterations") ||
		path.endsWith("SearchSteps") ||
		path.endsWith("FramesPerSecond")
	) {
		return { min: 1, max: 64, step: 1, decimals: 0, suffix: "" };
	}
	if (path.toLowerCase().includes("score")) {
		return { min: 0, max: 50, step: 0.5, decimals: 1, suffix: "" };
	}
	if (path.toLowerCase().includes("multiplier")) {
		return { min: 0.1, max: 10, step: 0.05, decimals: 2, suffix: "×" };
	}
	return { min: 0, max: 2, step: 0.005, decimals: 3, suffix: "" };
}

function normalizeNumber(path: string, value: unknown, fallback: number): number {
	const range = automaticDirectionNumberRange(path);
	const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	const clamped = clamp(candidate, range.min, range.max);
	return range.step >= 1 ? Math.round(clamped) : clamped;
}

function normalizeNode(defaultValue: unknown, value: unknown, path: string): unknown {
	if (typeof defaultValue === "number") return normalizeNumber(path, value, defaultValue);
	if (Array.isArray(defaultValue)) {
		if (path === "connectedClicks.panMotionSpeeds") {
			const values = Array.isArray(value) ? value.filter(isMotionSpeed) : [];
			return values.length > 0 ? [...new Set(values)] : [...(defaultValue as MotionSpeed[])];
		}
		const incoming = Array.isArray(value) ? value : [];
		return defaultValue.map((item, index) =>
			normalizeNode(item, incoming[index], `${path}.${index}`),
		);
	}
	const defaults = record(defaultValue);
	if (!defaults) return value ?? defaultValue;
	const incoming = record(value) ?? {};
	return Object.fromEntries(
		Object.entries(defaults).map(([key, item]) => [
			key,
			normalizeNode(item, incoming[key], path ? `${path}.${key}` : key),
		]),
	);
}

/** Validate unknown saved settings without letting malformed values reach the planner. */
export function normalizeAutomaticDirectionPolicy(value: unknown): AutomaticDirectionPolicy {
	const normalized = normalizeNode(DEFAULT_AUTOMATIC_DIRECTION_POLICY, value, "") as
		| AutomaticDirectionPolicy
		| undefined;
	const policy = structuredClone(normalized ?? DEFAULT_AUTOMATIC_DIRECTION_POLICY);
	policy.screen.minimumZoomDurationMs = Math.min(
		policy.screen.minimumZoomDurationMs,
		policy.screen.maximumZoomDurationMs,
	);
	policy.screen.defaultZoomDurationMs = clamp(
		policy.screen.defaultZoomDurationMs,
		policy.screen.minimumZoomDurationMs,
		policy.screen.maximumZoomDurationMs,
	);
	policy.screen.clickMinimumScale = Math.min(
		policy.screen.clickMinimumScale,
		policy.screen.clickMaximumScale,
	);
	policy.screen.traceMinDurationMs = Math.min(
		policy.screen.traceMinDurationMs,
		policy.screen.traceMaxDurationMs,
	);
	policy.screen.traceMinimumSpeed = Math.min(
		policy.screen.traceMinimumSpeed,
		policy.screen.traceMaximumSpeed,
	);
	policy.connectedClicks.dragMinimumDurationMs = Math.min(
		policy.connectedClicks.dragMinimumDurationMs,
		policy.connectedClicks.dragMaximumDurationMs,
	);
	policy.connectedClicks.minimumPanMs = Math.min(
		policy.connectedClicks.minimumPanMs,
		policy.connectedClicks.maximumPanMs,
	);
	policy.microphoneActivity.variationLowQuantile = Math.min(
		policy.microphoneActivity.variationLowQuantile,
		policy.microphoneActivity.variationHighQuantile,
	);
	for (let index = 1; index < policy.screen.clickEnvelopeScaleSteps.length; index += 1) {
		policy.screen.clickEnvelopeScaleSteps[index].maximumSpan = Math.max(
			policy.screen.clickEnvelopeScaleSteps[index - 1].maximumSpan,
			policy.screen.clickEnvelopeScaleSteps[index].maximumSpan,
		);
	}
	return policy;
}

function humanize(value: string): string {
	const withoutUnit = value.endsWith("Ms") ? value.slice(0, -2) : value;
	const words = withoutUnit.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	return `${words.charAt(0).toUpperCase()}${words.slice(1).toLowerCase()}`;
}

function collectNumberControls(
	value: unknown,
	path: string,
	controls: AutomaticDirectionNumberControl[],
): void {
	if (typeof value === "number") {
		if (LOCKED_CONTROL_PATHS.has(path) || path.startsWith("connectedClicks.panMotionSpeeds.")) {
			return;
		}
		const range = automaticDirectionNumberRange(path);
		const segments = path.split(".");
		const key = segments.at(-1) ?? path;
		const generatedLabel = /^\d+$/.test(key)
			? `${humanize(segments.at(-2) ?? "Value")} ${Number(key) + 1}`
			: humanize(key);
		const primary = PRIMARY_CONTROLS[path];
		controls.push({
			path,
			group: GROUP_LABELS[path.split(".")[0]] ?? "Advanced",
			label: primary?.label ?? generatedLabel,
			description: primary?.description ?? path,
			...range,
			primary: Boolean(primary),
		});
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => collectNumberControls(item, `${path}.${index}`, controls));
		return;
	}
	const object = record(value);
	if (!object) return;
	for (const [key, item] of Object.entries(object)) {
		collectNumberControls(item, path ? `${path}.${key}` : key, controls);
	}
}

export function automaticDirectionNumberControls(
	policy: AutomaticDirectionPolicy,
): AutomaticDirectionNumberControl[] {
	const controls: AutomaticDirectionNumberControl[] = [];
	collectNumberControls(policy, "", controls);
	return controls;
}

export function automaticDirectionPolicyValue(
	policy: AutomaticDirectionPolicy,
	path: string,
): number {
	let current: unknown = policy;
	for (const segment of path.split(".")) {
		current = Array.isArray(current) ? current[Number(segment)] : record(current)?.[segment];
	}
	return typeof current === "number" ? current : 0;
}

export function setAutomaticDirectionPolicyValue(
	policy: AutomaticDirectionPolicy,
	path: string,
	value: number,
): AutomaticDirectionPolicy {
	const next = structuredClone(policy) as unknown;
	const segments = path.split(".");
	let current: unknown = next;
	for (const [index, segment] of segments.entries()) {
		const last = index === segments.length - 1;
		if (Array.isArray(current)) {
			const itemIndex = Number(segment);
			if (last) current[itemIndex] = value;
			else current = current[itemIndex];
			continue;
		}
		const object = record(current);
		if (!object) break;
		if (last) object[segment] = value;
		else current = object[segment];
	}
	return normalizeAutomaticDirectionPolicy(next);
}

export function readAutomaticDirectionSettings(
	document: AxcutDocument,
): StoredAutomaticDirectionSettings {
	const legacy = record(document.legacyEditor);
	const stored = record(legacy?.[PROJECT_SETTINGS_KEY]);
	return {
		version: SETTINGS_VERSION,
		presetId:
			stored && "presetId" in stored
				? typeof stored.presetId === "string"
					? stored.presetId
					: null
				: DEFAULT_AUTOMATIC_DIRECTION_PRESET_ID,
		policy: normalizeAutomaticDirectionPolicy(stored?.policy),
	};
}

export function writeAutomaticDirectionSettings(
	document: AxcutDocument,
	settings: Pick<StoredAutomaticDirectionSettings, "policy" | "presetId">,
): AxcutDocument {
	const legacy = record(document.legacyEditor) ?? {};
	return {
		...document,
		legacyEditor: {
			...legacy,
			[PROJECT_SETTINGS_KEY]: {
				version: SETTINGS_VERSION,
				presetId: settings.presetId,
				policy: normalizeAutomaticDirectionPolicy(settings.policy),
			},
		},
	};
}

function diffPolicy(defaultValue: unknown, value: unknown): unknown {
	if (Array.isArray(defaultValue) && Array.isArray(value)) {
		return JSON.stringify(defaultValue) === JSON.stringify(value) ? undefined : value;
	}
	const defaults = record(defaultValue);
	const current = record(value);
	if (defaults && current) {
		const entries = Object.entries(defaults).flatMap(([key, item]) => {
			const difference = diffPolicy(item, current[key]);
			return difference === undefined ? [] : [[key, difference] as const];
		});
		return entries.length > 0 ? Object.fromEntries(entries) : undefined;
	}
	return Object.is(defaultValue, value) ? undefined : value;
}

function presetRecord(value: unknown): AutomaticDirectionPreset | null {
	const raw = record(value);
	if (typeof raw?.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name.trim()) {
		return null;
	}
	return {
		id: raw.id,
		name: raw.name.trim().slice(0, 64),
		overrides: record(raw.overrides) ?? {},
	};
}

export function loadAutomaticDirectionPresets(
	storage: PreferenceStorage = window.localStorage,
): AutomaticDirectionPreset[] {
	try {
		const parsed: unknown = JSON.parse(storage.getItem(PRESET_STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed)
			? parsed.flatMap((value) => {
					const preset = presetRecord(value);
					return preset ? [preset] : [];
				})
			: [];
	} catch {
		return [];
	}
}

export function policyForAutomaticDirectionPreset(
	preset: AutomaticDirectionPreset,
): AutomaticDirectionPolicy {
	return normalizeAutomaticDirectionPolicy(preset.overrides);
}

export function saveAutomaticDirectionPreset(
	name: string,
	policy: AutomaticDirectionPolicy,
	storage: PreferenceStorage = window.localStorage,
): AutomaticDirectionPreset | null {
	const cleanName = name.trim().slice(0, 64);
	if (!cleanName) return null;
	const preset: AutomaticDirectionPreset = {
		id: `custom-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
		name: cleanName,
		overrides:
			(record(diffPolicy(DEFAULT_AUTOMATIC_DIRECTION_POLICY, policy)) as Record<string, unknown>) ??
			{},
	};
	try {
		storage.setItem(
			PRESET_STORAGE_KEY,
			JSON.stringify([...loadAutomaticDirectionPresets(storage), preset]),
		);
		return preset;
	} catch {
		return null;
	}
}

export function deleteAutomaticDirectionPreset(
	id: string,
	storage: PreferenceStorage = window.localStorage,
): boolean {
	try {
		storage.setItem(
			PRESET_STORAGE_KEY,
			JSON.stringify(loadAutomaticDirectionPresets(storage).filter((preset) => preset.id !== id)),
		);
		return true;
	} catch {
		return false;
	}
}

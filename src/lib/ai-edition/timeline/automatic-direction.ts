import type { KeyboardActivitySample } from "@/native/contracts";
import type { AxcutDocument } from "../schema";
import { filterDismissedAutomaticDirection } from "./automatic-direction-ownership";
import {
	type AutoCameraEmphasisSuggestion,
	appendAutoCameraEmphasisSuggestions,
	buildAutoCameraEmphasisSuggestionsForTimeline,
	type CameraEmphasisPolicy,
	DEFAULT_CAMERA_EMPHASIS_POLICY,
} from "./camera-emphasis-suggestions";
import {
	AUTOMATIC_DIRECTION_MAX_SCALE,
	type ConnectedClickPolicy,
	DEFAULT_AUTOMATIC_DIRECTION_MAX_SCALE,
	DEFAULT_CONNECTED_CLICK_POLICY,
} from "./connected-click-policy";
import {
	DEFAULT_DIRECTION_POLICY,
	type DirectionCursorSample,
	type DirectionPolicy,
} from "./direction-engine";
import {
	DEFAULT_MICROPHONE_ACTIVITY_POLICY,
	type MicrophoneActivityPolicy,
	type MicrophoneActivitySpan,
} from "./microphone-activity";
import { DEFAULT_TYPING_DIRECTION_POLICY, type TypingDirectionPolicy } from "./typing-direction";
import {
	type AutoZoomSuggestion,
	appendAutoZoomSuggestions,
	buildAutoZoomSuggestionsForTimeline,
} from "./zoom-suggestions";

export interface AutomaticDirectionPolicy {
	/** Project-selected ceiling for generated screen crops. */
	maximumScreenScale: number;
	screen: DirectionPolicy;
	connectedClicks: ConnectedClickPolicy;
	typing: TypingDirectionPolicy;
	microphoneActivity: MicrophoneActivityPolicy;
	camera: CameraEmphasisPolicy;
}

export interface AutomaticDirectionPolicyOverrides {
	maximumScreenScale?: number;
	screen?: Partial<DirectionPolicy>;
	connectedClicks?: Partial<ConnectedClickPolicy>;
	typing?: Partial<TypingDirectionPolicy>;
	microphoneActivity?: Partial<MicrophoneActivityPolicy>;
	camera?: Partial<CameraEmphasisPolicy>;
}

/**
 * One typed tuning surface for every automatic-direction decision. A future
 * advanced UI can validate overrides and call this resolver without creating a
 * second analyzer or scattering constants through components.
 */
export function resolveAutomaticDirectionPolicy(
	overrides: AutomaticDirectionPolicyOverrides = {},
): AutomaticDirectionPolicy {
	const capScale = (value: number) => Math.min(AUTOMATIC_DIRECTION_MAX_SCALE, Math.max(1, value));
	const maximumScreenScale = Math.max(
		1.05,
		capScale(overrides.maximumScreenScale ?? DEFAULT_AUTOMATIC_DIRECTION_MAX_SCALE),
	);
	const screen = { ...DEFAULT_DIRECTION_POLICY, ...overrides.screen };
	screen.clickMinimumScale = capScale(screen.clickMinimumScale);
	screen.clickMaximumScale = capScale(screen.clickMaximumScale);
	screen.clickEnvelopeFallbackScale = capScale(screen.clickEnvelopeFallbackScale);
	screen.clickEnvelopeScaleSteps = screen.clickEnvelopeScaleSteps.map((step) => ({
		...step,
		scale: capScale(step.scale),
	}));
	screen.traceShortScale = capScale(screen.traceShortScale);
	screen.traceMediumScale = capScale(screen.traceMediumScale);
	screen.traceLongScale = capScale(screen.traceLongScale);
	const connectedClicks = { ...DEFAULT_CONNECTED_CLICK_POLICY, ...overrides.connectedClicks };
	connectedClicks.requestedScale = capScale(connectedClicks.requestedScale);
	return {
		maximumScreenScale,
		screen,
		connectedClicks,
		typing: { ...DEFAULT_TYPING_DIRECTION_POLICY, ...overrides.typing },
		microphoneActivity: {
			...DEFAULT_MICROPHONE_ACTIVITY_POLICY,
			...overrides.microphoneActivity,
		},
		camera: { ...DEFAULT_CAMERA_EMPHASIS_POLICY, ...overrides.camera },
	};
}

export const DEFAULT_AUTOMATIC_DIRECTION_POLICY = resolveAutomaticDirectionPolicy();

/**
 * Apply Max Zoom without destroying deeper values stored in a preset. If the
 * user raises the ceiling later, the original detector preferences return.
 */
export function resolveAutomaticDirectionPlanningPolicy(
	policy: AutomaticDirectionPolicy,
): AutomaticDirectionPolicy {
	const cap = Math.min(AUTOMATIC_DIRECTION_MAX_SCALE, Math.max(1.05, policy.maximumScreenScale));
	const profile = (value: number) => {
		const normalized = (value - 1) / Math.max(0.001, DEFAULT_AUTOMATIC_DIRECTION_MAX_SCALE - 1);
		return Math.min(cap, Math.max(1, 1 + normalized * (cap - 1)));
	};
	return {
		...policy,
		maximumScreenScale: cap,
		screen: {
			...policy.screen,
			clickMinimumScale: Math.min(policy.screen.clickMinimumScale, cap),
			clickMaximumScale: profile(policy.screen.clickMaximumScale),
			clickEnvelopeFallbackScale: profile(policy.screen.clickEnvelopeFallbackScale),
			clickEnvelopeScaleSteps: policy.screen.clickEnvelopeScaleSteps.map((step) => ({
				...step,
				scale: profile(step.scale),
			})),
			traceShortScale: profile(policy.screen.traceShortScale),
			traceMediumScale: profile(policy.screen.traceMediumScale),
			traceLongScale: profile(policy.screen.traceLongScale),
		},
		connectedClicks: {
			...policy.connectedClicks,
			requestedScale: profile(policy.connectedClicks.requestedScale),
			passageMinimumStableScale: Math.min(policy.connectedClicks.passageMinimumStableScale, cap),
		},
	};
}

export interface RecordedDirectionObservation {
	assetId: string;
	cursorTelemetry: DirectionCursorSample[];
	keyboardActivity?: KeyboardActivitySample[];
	microphoneActivity?: MicrophoneActivitySpan[];
}

export type AutomaticDirectionEffect =
	| { id: string; kind: "screen-zoom"; suggestion: AutoZoomSuggestion }
	| { id: string; kind: "camera-emphasis"; suggestion: AutoCameraEmphasisSuggestion };

export interface AutomaticDirectionPlan {
	schemaVersion: 1;
	id: string;
	effects: AutomaticDirectionEffect[];
}

export interface AutomaticDirectionPhases {
	screen: boolean;
	camera: boolean;
}

function automaticCameraRegions(document: AxcutDocument) {
	return (
		((document.legacyEditor as Record<string, unknown> | null)?.cameraFullscreenRegions as
			| Array<{ startMs: number; endMs: number; directionGroupId?: string }>
			| undefined) ?? []
	);
}

/**
 * Build one coherent plan from all currently available observations. Screen
 * intent owns the first pass. Camera Emphasis can then fill quiet, unoccupied
 * moments without displacing a useful on-screen action.
 */
export function buildAutomaticDirectionPlan(options: {
	id: string;
	document: AxcutDocument;
	recordings: RecordedDirectionObservation[];
	phases?: Partial<AutomaticDirectionPhases>;
	policy?: AutomaticDirectionPolicy;
}): AutomaticDirectionPlan {
	const policy = resolveAutomaticDirectionPlanningPolicy(
		options.policy ?? DEFAULT_AUTOMATIC_DIRECTION_POLICY,
	);
	const phases: AutomaticDirectionPhases = {
		screen: options.phases?.screen ?? true,
		camera: options.phases?.camera ?? true,
	};
	const effects: AutomaticDirectionEffect[] = [];
	let workingDocument = options.document;

	if (phases.screen) {
		const occupiedCamera = automaticCameraRegions(workingDocument).map((region) => ({
			start: region.startMs,
			end: region.endMs,
			directionGroupId: region.directionGroupId,
		}));
		const screenSuggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: options.recordings.map((recording) => ({
				assetId: recording.assetId,
				cursorTelemetry: recording.cursorTelemetry,
				keyboardActivity: recording.keyboardActivity,
			})),
			clips: workingDocument.timeline.clips,
			trimRanges: workingDocument.timeline.trimRanges,
			existingRegions: workingDocument.zoomRanges.map((region) => ({
				startMs: region.startMs,
				endMs: region.endMs,
				directionGroupId: region.directionGroupId,
			})),
			occupiedDirections: occupiedCamera.map((region) => ({
				startMs: region.start,
				endMs: region.end,
				directionGroupId: region.directionGroupId,
			})),
			maximumTotalDirectionsPerMinute: policy.camera.maxTotalDirectionPerMinute,
			defaultDurationMs: policy.screen.defaultZoomDurationMs,
			directionPolicy: policy.screen,
			connectedClickPolicy: policy.connectedClicks,
			typingDirectionPolicy: policy.typing,
		});
		effects.push(
			...screenSuggestions.map((suggestion, index) => ({
				id: `screen-${index}`,
				kind: "screen-zoom" as const,
				suggestion,
			})),
		);
		workingDocument = appendAutoZoomSuggestions(workingDocument, screenSuggestions);
	}

	if (phases.camera) {
		const cameraSuggestions = buildAutoCameraEmphasisSuggestionsForTimeline({
			recordings: options.recordings.map((recording) => ({
				assetId: recording.assetId,
				cursorTelemetry: recording.cursorTelemetry,
				keyboardActivity: recording.keyboardActivity,
				microphoneActivity: recording.microphoneActivity ?? [],
			})),
			cameraAssetIds: new Set(
				workingDocument.assets
					.filter((asset) => asset.cameraTrack != null && asset.cameraTrack.visible !== false)
					.map((asset) => asset.id),
			),
			clips: workingDocument.timeline.clips,
			trimRanges: workingDocument.timeline.trimRanges,
			occupiedScreenDirections: workingDocument.zoomRanges.map((region) => ({
				start: region.startMs,
				end: region.endMs,
				directionGroupId: region.directionGroupId,
			})),
			existingCameraRegions: automaticCameraRegions(workingDocument),
			policy: policy.camera,
		});
		effects.push(
			...cameraSuggestions.map((suggestion, index) => ({
				id: `camera-${index}`,
				kind: "camera-emphasis" as const,
				suggestion,
			})),
		);
		workingDocument = appendAutoCameraEmphasisSuggestions(workingDocument, cameraSuggestions);
	}

	return { schemaVersion: 1, id: options.id, effects };
}

function effectPrefix(plan: AutomaticDirectionPlan, effect: AutomaticDirectionEffect) {
	return `auto-direction:${plan.id}:${effect.id}:`;
}

/** Namespace a local detector sequence so it stays stable and unique in the project. */
export function materializeAutomaticDirectionEffect(
	plan: AutomaticDirectionPlan,
	effect: AutomaticDirectionEffect,
): AutomaticDirectionEffect {
	const localGroup = effect.suggestion.directionGroupId ?? effect.id;
	const directionGroupId = `auto-direction:${plan.id}:${effect.kind}:${localGroup}`;
	if (effect.kind === "screen-zoom") {
		return { ...effect, suggestion: { ...effect.suggestion, directionGroupId } };
	}
	return { ...effect, suggestion: { ...effect.suggestion, directionGroupId } };
}

function hasEffect(document: AxcutDocument, prefix: string) {
	if (document.zoomRanges.some((region) => region.id.startsWith(prefix))) return true;
	return automaticCameraRegions(document).some(
		(region) => "id" in region && String(region.id).startsWith(prefix),
	);
}

/** Convert a plan into ordinary clip-anchored timeline regions. */
export function applyAutomaticDirectionPlan(
	document: AxcutDocument,
	plan: AutomaticDirectionPlan,
): AxcutDocument {
	let next = document;
	for (const effect of plan.effects) {
		const prefix = effectPrefix(plan, effect);
		if (hasEffect(next, prefix)) continue;
		let fragment = 0;
		const createRegionId = () => `${prefix}${fragment++}`;
		const materialized = materializeAutomaticDirectionEffect(plan, effect);
		next =
			materialized.kind === "screen-zoom"
				? appendAutoZoomSuggestions(next, [materialized.suggestion], createRegionId)
				: appendAutoCameraEmphasisSuggestions(next, [materialized.suggestion], createRegionId);
	}
	return filterDismissedAutomaticDirection(next);
}

/** Build and apply a fresh plan against one document snapshot. */
export function applyAutomaticDirection(options: {
	id: string;
	document: AxcutDocument;
	recordings: RecordedDirectionObservation[];
	phases?: Partial<AutomaticDirectionPhases>;
	policy?: AutomaticDirectionPolicy;
}): AxcutDocument {
	return applyAutomaticDirectionPlan(options.document, buildAutomaticDirectionPlan(options));
}

/**
 * Remove only edits created by automatic direction. Manual Zoom, camera,
 * timing, caption, annotation, and layout edits remain unchanged. Keeping this
 * operation in the direction domain makes import, regeneration, and a future
 * tuning UI use the same ownership rule.
 */
export function removeAutomaticDirection(document: AxcutDocument): AxcutDocument {
	const zoomRanges = document.zoomRanges.filter((region) => region.source !== "auto");
	const legacy = (document.legacyEditor as Record<string, unknown> | null) ?? {};
	const cameraFullscreenRegions = (
		(legacy.cameraFullscreenRegions as Array<{ source?: string }> | undefined) ?? []
	).filter((region) => region.source !== "auto");
	if (
		zoomRanges.length === document.zoomRanges.length &&
		cameraFullscreenRegions.length ===
			((legacy.cameraFullscreenRegions as unknown[] | undefined)?.length ?? 0)
	) {
		return document;
	}
	return {
		...document,
		zoomRanges,
		legacyEditor: { ...legacy, cameraFullscreenRegions },
	};
}

/** Replace the current automatic plan while preserving all manual work. */
export function regenerateAutomaticDirection(options: {
	id: string;
	document: AxcutDocument;
	recordings: RecordedDirectionObservation[];
	policy?: AutomaticDirectionPolicy;
}): AxcutDocument {
	return applyAutomaticDirection({
		...options,
		document: removeAutomaticDirection(options.document),
	});
}

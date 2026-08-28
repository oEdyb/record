// Deterministic automatic direction. Pure, local, and intentionally small.
//
// This engine turns screen-intent observations into sparse Zoom candidates.
// `automatic-direction.ts` composes this output with camera intent and applies
// every accepted effect through the ordinary editable timeline schema.

import type { MotionSpeed } from "@/lib/zoomMath/motionCurve";
import { CHAINED_ZOOM_PAN_GAP_MS } from "@/lib/zoomMath/zoomRegionUtils";
import { planConnectedClickChains, resolveCursorSafeFixedZoom } from "./connected-click-chain";
import {
	AUTOMATIC_DIRECTION_MAX_SCALE,
	type ConnectedClickPolicy,
	DEFAULT_CONNECTED_CLICK_POLICY,
} from "./connected-click-policy";
import { fitDirectionActivityEnvelope } from "./direction-activity-envelope";
import { buildDragFocusActivities } from "./drag-direction";

export interface DirectionCursorSample {
	timeMs: number;
	cx: number;
	cy: number;
	visible?: boolean;
	cursorType?: string | null;
	interactionType?: string | null;
	/** True while the pointer is over recorder UI that is absent from the video. */
	directionExcluded?: boolean;
	/** Optional ranking weight for a derived focus activity such as typing. */
	directionWeight?: number;
	/** Groups one renewable derived activity without changing its score. */
	directionActivityId?: string;
	/** Opaque capture context; no app name, window title, or content. */
	directionContextId?: string;
	/** A hard editorial boundary caused by an app-context change. */
	directionContextChanged?: boolean;
	/** Optional bounded area for a derived focus activity such as typing. */
	framingRect?: { x: number; y: number; width: number; height: number };
}

export interface DirectionSpan {
	start: number;
	end: number;
	/** Renderer passage identity. Different non-empty groups never share one entrance. */
	directionGroupId?: string;
	/** Kept playback segment. A cut is always a hard passage boundary. */
	segmentId?: string;
}

export interface DirectionZoomCandidate {
	signal: "click" | "trace";
	span: DirectionSpan;
	focus: { cx: number; cy: number };
	focusMode: "manual" | "auto";
	customScale: number;
	score: number;
	motionSpeed?: MotionSpeed;
	/** Targets with the same id count as one sparse direction sequence. */
	sequenceId?: string;
	/** Complete occupied span for every target in a connected sequence. */
	sequenceSpan?: DirectionSpan;
	/** Input activity span, separate from visual pre-roll and hold. */
	intentSpan?: DirectionSpan;
	/** Renewable typing can stay connected without the click-only duration cap. */
	connectionMode?: "bounded" | "renewable";
	/** Connected gestures include transition time outside their short authored target bodies. */
	minimumDurationExempt?: boolean;
}

export interface DirectionPlan {
	zooms: DirectionZoomCandidate[];
}

export interface DirectionPolicy {
	defaultZoomDurationMs: number;
	minimumZoomDurationMs: number;
	maximumZoomDurationMs: number;
	clickClusterGapMs: number;
	clickClusterMaximumDurationMs: number;
	clickClusterRadius: number;
	clickPreRollMs: number;
	clickPostRollMs: number;
	clickAttentionWindowMs: number;
	clickObservationTailMs: number;
	clickTargetSettleMs: number;
	clickMaximumFollowDistance: number;
	clickEnvelopeOutlierTrimRatio: number;
	clickEnvelopePadding: number;
	clickEnvelopeScaleSteps: ReadonlyArray<{ maximumSpan: number; scale: number }>;
	clickEnvelopeFallbackScale: number;
	clickMinimumScale: number;
	clickMaximumScale: number;
	clickScorePerInteraction: number;
	clickAttentionScoreUnitMs: number;
	clickMaximumAttentionScore: number;
	settleRadius: number;
	traceMinPath: number;
	traceMinNetDistance: number;
	traceMinEfficiency: number;
	traceMinDurationMs: number;
	traceMaxDurationMs: number;
	traceSettleMs: number;
	traceNearbyClickWindowMs: number;
	traceMinimumSpeed: number;
	traceMaximumSpeed: number;
	tracePreRollMs: number;
	tracePostRollMs: number;
	traceShortPathThreshold: number;
	traceMediumPathThreshold: number;
	traceShortScale: number;
	traceMediumScale: number;
	traceLongScale: number;
	traceMaximumSampleGapMs: number;
	traceMaximumSampleStep: number;
	traceMinimumMotionStep: number;
	traceBaseScore: number;
	traceSettleScoreUnitMs: number;
	traceMaximumSettleScore: number;
	minimumSpacingMs: number;
	sequenceConnectionGapMs: number;
	maxZoomsPerMinute: number;
}

export const DEFAULT_DIRECTION_POLICY: DirectionPolicy = {
	defaultZoomDurationMs: 3_000,
	minimumZoomDurationMs: 2_700,
	maximumZoomDurationMs: 6_000,
	clickClusterGapMs: 1_800,
	clickClusterMaximumDurationMs: 2_800,
	clickClusterRadius: 0.14,
	clickPreRollMs: 350,
	clickPostRollMs: 1_600,
	clickAttentionWindowMs: 4_500,
	clickObservationTailMs: 450,
	clickTargetSettleMs: 450,
	clickMaximumFollowDistance: 0.5,
	clickEnvelopeOutlierTrimRatio: 0.08,
	clickEnvelopePadding: 0.045,
	clickEnvelopeScaleSteps: [
		{ maximumSpan: 0.06, scale: 1.65 },
		{ maximumSpan: 0.16, scale: 1.65 },
		{ maximumSpan: 0.3, scale: 1.5 },
		{ maximumSpan: 0.48, scale: 1.35 },
	],
	clickEnvelopeFallbackScale: 1.35,
	clickMinimumScale: 1.35,
	clickMaximumScale: 1.65,
	clickScorePerInteraction: 5,
	clickAttentionScoreUnitMs: 500,
	clickMaximumAttentionScore: 2,
	settleRadius: 0.035,
	traceMinPath: 0.12,
	traceMinNetDistance: 0.08,
	traceMinEfficiency: 0.58,
	traceMinDurationMs: 700,
	traceMaxDurationMs: 3_500,
	traceSettleMs: 450,
	traceNearbyClickWindowMs: 300,
	traceMinimumSpeed: 0.04,
	traceMaximumSpeed: 0.5,
	tracePreRollMs: 250,
	tracePostRollMs: 500,
	traceShortPathThreshold: 0.22,
	traceMediumPathThreshold: 0.4,
	traceShortScale: 1.5,
	traceMediumScale: 1.4,
	traceLongScale: 1.3,
	traceMaximumSampleGapMs: 300,
	traceMaximumSampleStep: 0.35,
	traceMinimumMotionStep: 0.0015,
	traceBaseScore: 2,
	traceSettleScoreUnitMs: 1_000,
	traceMaximumSettleScore: 1,
	// The default has no rejection-only gap: a nearby effect either connects to
	// the prior effect or remains as a separate effect once that window ends.
	minimumSpacingMs: CHAINED_ZOOM_PAN_GAP_MS,
	sequenceConnectionGapMs: CHAINED_ZOOM_PAN_GAP_MS,
	maxZoomsPerMinute: 4,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const automaticScale = (value: number) => clamp(value, 1, AUTOMATIC_DIRECTION_MAX_SCALE);
const CLICK_INTERACTIONS = new Set(["click", "double-click", "right-click", "middle-click"]);
const FOCUS_INTERACTIONS = new Set([...CLICK_INTERACTIONS, "typing"]);

const distance = (a: DirectionCursorSample, b: DirectionCursorSample) =>
	Math.hypot(a.cx - b.cx, a.cy - b.cy);

const gapBetween = (a: DirectionSpan, b: DirectionSpan) =>
	Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));

/**
 * Put raw recorder samples on the one contract every detector expects.
 * Keeping this public lets timeline projection sort each recording once, then
 * use binary slices for its clips instead of rescanning the whole sidecar.
 */
export function normalizeDirectionCursor(
	cursor: DirectionCursorSample[],
	durationMs: number,
): DirectionCursorSample[] {
	return cursor
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy) &&
				sample.timeMs >= 0 &&
				sample.timeMs <= durationMs,
		)
		.map((sample) => ({
			...sample,
			cx: clamp(sample.cx, 0, 1),
			cy: clamp(sample.cy, 0, 1),
			...(sample.directionContextChanged ? { directionExcluded: true } : {}),
		}))
		.sort((a, b) => a.timeMs - b.timeMs);
}

function lowerBoundByTime(cursor: DirectionCursorSample[], timeMs: number) {
	let low = 0;
	let high = cursor.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (cursor[middle].timeMs < timeMs) low = middle + 1;
		else high = middle;
	}
	return low;
}

function lowerBoundNumber(values: number[], target: number) {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

function fitSpan(
	startMs: number,
	endMs: number,
	durationMs: number,
	preferredDurationMs: number,
	policy: DirectionPolicy,
): DirectionSpan {
	const minimumDuration = clamp(
		preferredDurationMs,
		policy.minimumZoomDurationMs,
		policy.maximumZoomDurationMs,
	);
	const maximumDuration = Math.max(minimumDuration, policy.maximumZoomDurationMs);
	let start = Math.max(0, startMs);
	let end = Math.min(durationMs, endMs);
	if (end - start < minimumDuration) {
		const missing = minimumDuration - (end - start);
		end = Math.min(durationMs, end + missing);
		start = Math.max(0, end - minimumDuration);
	}
	if (end - start > maximumDuration) {
		const midpoint = (start + end) / 2;
		start = Math.max(0, midpoint - maximumDuration / 2);
		end = Math.min(durationMs, start + maximumDuration);
		start = Math.max(0, end - maximumDuration);
	}
	return { start: Math.round(start), end: Math.round(end) };
}

function weightedClickFocus(clicks: DirectionCursorSample[]) {
	let totalWeight = 0;
	let cx = 0;
	let cy = 0;
	for (let index = 0; index < clicks.length; index += 1) {
		const weight = index + 1;
		totalWeight += weight;
		cx += clicks[index].cx * weight;
		cy += clicks[index].cy * weight;
	}
	return { cx: cx / totalWeight, cy: cy / totalWeight };
}

/**
 * A quick relocation followed by a long park is usually the user getting the
 * pointer out of the way, not a request to frame both places. Keep nearby
 * settled targets in the click envelope. If the pointer settles far away,
 * end the click observation at the last sample that was still near the click.
 */
function trimDistantSettledDeparture(
	activity: DirectionCursorSample[],
	clicks: DirectionCursorSample[],
	lastClickTimeMs: number,
	policy: DirectionPolicy,
) {
	const clickFocus = weightedClickFocus(clicks);
	const firstAfterClick = activity.findIndex((sample) => sample.timeMs > lastClickTimeMs);
	if (firstAfterClick < 0) return activity;

	for (let start = firstAfterClick; start < activity.length; start += 1) {
		const target = activity[start];
		if (
			Math.hypot(target.cx - clickFocus.cx, target.cy - clickFocus.cy) <=
			policy.clickMaximumFollowDistance
		) {
			continue;
		}
		let settled = false;
		for (let end = start + 1; end < activity.length; end += 1) {
			if (distance(target, activity[end]) > policy.settleRadius) break;
			if (activity[end].timeMs - target.timeMs >= policy.clickTargetSettleMs) {
				settled = true;
				break;
			}
		}
		if (!settled) continue;

		let departure = start;
		while (
			departure > firstAfterClick &&
			Math.hypot(
				activity[departure - 1].cx - clickFocus.cx,
				activity[departure - 1].cy - clickFocus.cy,
			) > policy.settleRadius
		) {
			departure -= 1;
		}
		return activity.slice(0, departure);
	}
	return activity;
}

export function detectClickDirectionCandidates(options: {
	cursor: DirectionCursorSample[];
	durationMs: number;
	preferredZoomDurationMs: number;
	policy?: DirectionPolicy;
	cursorSafetyPolicy?: ConnectedClickPolicy;
}): DirectionZoomCandidate[] {
	const { cursor, durationMs, preferredZoomDurationMs } = options;
	const policy = options.policy ?? DEFAULT_DIRECTION_POLICY;
	const clicks = cursor.filter(
		(sample) =>
			sample.visible !== false &&
			!sample.directionExcluded &&
			FOCUS_INTERACTIONS.has(sample.interactionType ?? ""),
	);
	if (clicks.length === 0) return [];

	const groups: DirectionCursorSample[][] = [];
	for (const click of clicks) {
		const group = groups.at(-1);
		if (!group) {
			groups.push([click]);
			continue;
		}
		const first = group[0];
		const previous = group[group.length - 1];
		const focus = weightedClickFocus(group);
		const closeInTime = click.timeMs - previous.timeMs <= policy.clickClusterGapMs;
		const shortEnough = click.timeMs - first.timeMs <= policy.clickClusterMaximumDurationMs;
		const closeInSpace =
			Math.hypot(click.cx - focus.cx, click.cy - focus.cy) <= policy.clickClusterRadius;
		if (closeInTime && shortEnough && closeInSpace) group.push(click);
		else groups.push([click]);
	}

	return groups.flatMap((group, groupIndex) => {
		const first = group[0];
		const last = group[group.length - 1];
		const nextClick = groups[groupIndex + 1]?.[0];
		const nextClickMs = nextClick?.timeMs ?? Number.POSITIVE_INFINITY;
		const hasDistinctNextTarget =
			Boolean(nextClick) && distance(last, nextClick) > policy.clickClusterRadius;
		const activity: DirectionCursorSample[] = [];
		let observedUntilMs = last.timeMs;
		for (let index = lowerBoundByTime(cursor, first.timeMs); index < cursor.length; index += 1) {
			const sample = cursor[index];
			if (
				sample.timeMs >= nextClickMs ||
				sample.timeMs > last.timeMs + policy.clickAttentionWindowMs
			) {
				break;
			}
			if (sample.visible === false || sample.directionExcluded) break;
			if (
				hasDistinctNextTarget &&
				nextClick &&
				sample.timeMs > last.timeMs &&
				distance(sample, nextClick) <= policy.settleRadius
			) {
				break;
			}
			activity.push(sample);
			observedUntilMs = sample.timeMs;
		}
		const acceptedActivity = trimDistantSettledDeparture(activity, group, last.timeMs, policy);
		observedUntilMs = acceptedActivity.at(-1)?.timeMs ?? last.timeMs;
		const envelope = fitDirectionActivityEnvelope({
			points: acceptedActivity,
			anchors: group,
			policy: {
				outlierTrimRatio: policy.clickEnvelopeOutlierTrimRatio,
				padding: policy.clickEnvelopePadding,
				minimumScale: policy.clickMinimumScale,
				maximumScale: policy.clickMaximumScale,
				scaleSteps: policy.clickEnvelopeScaleSteps,
				fallbackScale: policy.clickEnvelopeFallbackScale,
			},
		});
		if (!envelope) return [];
		const attentionMs = Math.max(0, observedUntilMs - last.timeMs);
		const span = fitSpan(
			first.timeMs - policy.clickPreRollMs,
			Math.max(
				last.timeMs + policy.clickPostRollMs,
				observedUntilMs + policy.clickObservationTailMs,
			),
			durationMs,
			preferredZoomDurationMs,
			policy,
		);
		const safeZoom = resolveCursorSafeFixedZoom({
			span,
			minimumEndMs:
				last.timeMs +
				(options.cursorSafetyPolicy ?? DEFAULT_CONNECTED_CLICK_POLICY).minimumTargetHoldMs,
			focus: envelope.focus,
			requestedScale: automaticScale(envelope.scale),
			cursor,
			policy: options.cursorSafetyPolicy,
		});
		if (safeZoom.scale < policy.clickMinimumScale) return [];
		return [
			{
				signal: "click" as const,
				span: safeZoom.zooms[0].span,
				focus: envelope.focus,
				focusMode: "manual" as const,
				customScale: safeZoom.scale,
				score:
					group.length * policy.clickScorePerInteraction +
					Math.min(
						policy.clickMaximumAttentionScore,
						attentionMs / policy.clickAttentionScoreUnitMs,
					),
				intentSpan: { start: first.timeMs, end: last.timeMs },
				connectionMode: "bounded" as const,
			},
		];
	});
}

export function detectTraceDirectionCandidates(options: {
	cursor: DirectionCursorSample[];
	durationMs: number;
	preferredZoomDurationMs: number;
	policy?: DirectionPolicy;
}): DirectionZoomCandidate[] {
	const { cursor, durationMs, preferredZoomDurationMs } = options;
	const policy = options.policy ?? DEFAULT_DIRECTION_POLICY;
	if (cursor.length < 3) return [];

	const candidates: DirectionZoomCandidate[] = [];
	const clickTimes = cursor
		.filter(
			(sample) =>
				sample.visible !== false &&
				!sample.directionExcluded &&
				FOCUS_INTERACTIONS.has(sample.interactionType ?? ""),
		)
		.map((sample) => sample.timeMs);
	let runStartIndex: number | null = null;
	let lastMotionIndex = -1;
	let path = 0;

	const finishRun = (settleIndex: number) => {
		if (runStartIndex === null || lastMotionIndex <= runStartIndex) return;
		const start = cursor[runStartIndex];
		const lastMotion = cursor[lastMotionIndex];
		const settled = cursor[settleIndex];
		const movementDuration = lastMotion.timeMs - start.timeMs;
		const netDistance = distance(start, lastMotion);
		const efficiency = path > 0 ? netDistance / path : 0;
		const speed = movementDuration > 0 ? path / (movementDuration / 1_000) : 0;
		const nearbyClickIndex = lowerBoundNumber(
			clickTimes,
			start.timeMs - policy.traceNearbyClickWindowMs,
		);
		const hasNearbyClick =
			(clickTimes[nearbyClickIndex] ?? Number.POSITIVE_INFINITY) <=
			settled.timeMs + policy.traceNearbyClickWindowMs;
		const settledForMs = settled.timeMs - lastMotion.timeMs;
		if (
			!hasNearbyClick &&
			settledForMs >= policy.traceSettleMs &&
			movementDuration >= policy.traceMinDurationMs &&
			movementDuration <= policy.traceMaxDurationMs &&
			path >= policy.traceMinPath &&
			netDistance >= policy.traceMinNetDistance &&
			efficiency >= policy.traceMinEfficiency &&
			speed >= policy.traceMinimumSpeed &&
			speed <= policy.traceMaximumSpeed
		) {
			candidates.push({
				signal: "trace",
				span: fitSpan(
					start.timeMs - policy.tracePreRollMs,
					settled.timeMs + policy.tracePostRollMs,
					durationMs,
					preferredZoomDurationMs,
					policy,
				),
				focus: { cx: lastMotion.cx, cy: lastMotion.cy },
				focusMode: "auto",
				customScale: automaticScale(
					path < policy.traceShortPathThreshold
						? policy.traceShortScale
						: path < policy.traceMediumPathThreshold
							? policy.traceMediumScale
							: policy.traceLongScale,
				),
				score:
					policy.traceBaseScore +
					efficiency +
					Math.min(
						policy.traceMaximumSettleScore,
						(settled.timeMs - lastMotion.timeMs) / policy.traceSettleScoreUnitMs,
					),
				intentSpan: { start: start.timeMs, end: settled.timeMs },
				connectionMode: "bounded",
			});
		}
	};

	for (let index = 1; index < cursor.length; index += 1) {
		const previous = cursor[index - 1];
		const current = cursor[index];
		if (
			previous.visible === false ||
			current.visible === false ||
			previous.directionExcluded ||
			current.directionExcluded
		) {
			if (runStartIndex !== null) finishRun(Math.max(lastMotionIndex, index - 1));
			runStartIndex = null;
			lastMotionIndex = -1;
			path = 0;
			continue;
		}
		const elapsed = current.timeMs - previous.timeMs;
		const step = distance(previous, current);
		if (
			elapsed <= 0 ||
			elapsed > policy.traceMaximumSampleGapMs ||
			step > policy.traceMaximumSampleStep
		) {
			if (runStartIndex !== null) finishRun(Math.max(lastMotionIndex, index - 1));
			runStartIndex = null;
			lastMotionIndex = -1;
			path = 0;
			continue;
		}
		if (step >= policy.traceMinimumMotionStep) {
			if (runStartIndex === null) runStartIndex = index - 1;
			path += step;
			lastMotionIndex = index;
			continue;
		}
		if (
			runStartIndex !== null &&
			lastMotionIndex >= 0 &&
			current.timeMs - cursor[lastMotionIndex].timeMs >= policy.traceSettleMs
		) {
			finishRun(index);
			runStartIndex = null;
			lastMotionIndex = -1;
			path = 0;
		}
	}
	if (
		runStartIndex !== null &&
		lastMotionIndex >= 0 &&
		cursor.at(-1)!.timeMs - cursor[lastMotionIndex].timeMs >= policy.traceSettleMs
	) {
		finishRun(cursor.length - 1);
	}

	return candidates;
}

export function detectDirectionCandidates(options: {
	cursor: DirectionCursorSample[];
	focusActivities?: DirectionCursorSample[];
	durationMs: number;
	preferredZoomDurationMs: number;
	policy?: DirectionPolicy;
	connectedClickPolicy?: ConnectedClickPolicy;
}): DirectionZoomCandidate[] {
	const policy = options.policy ?? DEFAULT_DIRECTION_POLICY;
	const connectedClickPolicy = options.connectedClickPolicy ?? DEFAULT_CONNECTED_CLICK_POLICY;
	const connected = planConnectedClickChains({
		cursor: options.cursor,
		focusActivities: [
			...(options.focusActivities ?? []),
			...buildDragFocusActivities(options.cursor, connectedClickPolicy),
		],
		durationMs: options.durationMs,
		policy: connectedClickPolicy,
	});
	// A short click-only passage that needs a weaker scale than the stable floor
	// reads as one almost invisible Zoom, so local clicks are clearer. A passage
	// that crossed an internal detector safeguard is sustained activity: keep it
	// coherent so the selector cannot drop a later part of the same interaction.
	const usableConnectedSequences = connected.sequences.filter(
		(sequence) =>
			sequence.renewable ||
			sequence.detectorChainCount > 1 ||
			(sequence.containsDrag && sequence.detectorChainCount <= 2) ||
			sequence.resolvedScale >= connectedClickPolicy.passageMinimumStableScale,
	);
	const connectedCandidates = usableConnectedSequences.flatMap((sequence) => {
		const totalScore = sequence.scoreWeight * policy.clickScorePerInteraction;
		const scorePerTarget = totalScore / sequence.zooms.length;
		return sequence.zooms.map((zoom) => ({
			signal: "click" as const,
			span: zoom.span,
			focus: zoom.focus,
			focusMode: "manual" as const,
			customScale: automaticScale(zoom.customScale),
			score: scorePerTarget,
			motionSpeed: zoom.motionSpeed,
			sequenceId: sequence.id,
			sequenceSpan: sequence.span,
			intentSpan: sequence.intentSpan,
			connectionMode: sequence.renewable ? ("renewable" as const) : ("bounded" as const),
			minimumDurationExempt: true,
		}));
	});
	const consumedSpans = usableConnectedSequences.map((sequence) => sequence.intentSpan);
	const singleClickCursor = [...options.cursor, ...(options.focusActivities ?? [])]
		.sort((left, right) => left.timeMs - right.timeMs)
		.filter(
			(sample) =>
				!FOCUS_INTERACTIONS.has(sample.interactionType ?? "") ||
				!consumedSpans.some((span) => sample.timeMs >= span.start && sample.timeMs <= span.end),
		);
	return [
		...connectedCandidates,
		...detectClickDirectionCandidates({
			cursor: singleClickCursor,
			durationMs: options.durationMs,
			preferredZoomDurationMs: options.preferredZoomDurationMs,
			policy,
			cursorSafetyPolicy: connectedClickPolicy,
		}),
		...detectTraceDirectionCandidates({
			cursor: options.cursor,
			durationMs: options.durationMs,
			preferredZoomDurationMs: options.preferredZoomDurationMs,
			policy,
		}),
	];
}

function spansOverlap(a: DirectionSpan, b: DirectionSpan) {
	return a.end > b.start && a.start < b.end;
}

function mergeOccupiedSequences(
	spans: DirectionSpan[],
	durationMs: number,
	connectionGapMs: number,
): DirectionSpan[] {
	const ordered = spans
		.map((span) => ({
			start: Math.max(0, span.start),
			end: Math.min(durationMs, span.end),
			directionGroupId: span.directionGroupId,
			segmentId: span.segmentId,
		}))
		.filter((span) => span.end > span.start)
		.sort((a, b) => a.start - b.start);
	const merged: DirectionSpan[] = [];
	for (const span of ordered) {
		const previous = merged.at(-1);
		const groupsCanConnect =
			previous &&
			previous.segmentId === span.segmentId &&
			((previous.directionGroupId === undefined && span.directionGroupId === undefined) ||
				(previous.directionGroupId !== undefined &&
					previous.directionGroupId === span.directionGroupId));
		if (!previous || !groupsCanConnect || span.start > previous.end + connectionGapMs) {
			merged.push({ ...span });
		} else {
			previous.end = Math.max(previous.end, span.end);
		}
	}
	return merged;
}

function staysWithinRollingSequenceBudget(
	sequences: DirectionSpan[],
	perMinute: number,
	budgetDurationMs: number,
) {
	const starts = sequences.map((span) => span.start).sort((left, right) => left - right);
	const limit = Math.max(
		1,
		budgetDurationMs < 60_000
			? Math.ceil((budgetDurationMs / 60_000) * perMinute)
			: Math.floor(perMinute),
	);
	let first = 0;
	for (let last = 0; last < starts.length; last += 1) {
		while (starts[last] - starts[first] >= 60_000) first += 1;
		if (last - first + 1 > limit) return false;
	}
	return true;
}

export function selectDirectionCandidates(options: {
	candidates: DirectionZoomCandidate[];
	/** Raw coordinate extent used to validate occupied spans. */
	durationMs: number;
	/** Optional kept playback duration used only for the motion allowance. */
	budgetDurationMs?: number;
	/** Existing screen Zoom regions. These consume the screen-specific budget. */
	occupiedZooms?: DirectionSpan[];
	/** Existing non-screen direction such as Camera Emphasis. */
	occupiedDirections?: DirectionSpan[];
	maximumTotalDirectionsPerMinute?: number;
	policy?: DirectionPolicy;
}): DirectionZoomCandidate[] {
	const policy = options.policy ?? DEFAULT_DIRECTION_POLICY;
	const occupiedZooms = options.occupiedZooms ?? [];
	const occupiedDirections = options.occupiedDirections ?? [];
	const allOccupiedDirections = [...occupiedZooms, ...occupiedDirections];
	const budgetDurationMs = options.budgetDurationMs ?? options.durationMs;
	const totalDirectionsPerMinute =
		options.maximumTotalDirectionsPerMinute ?? policy.maxZoomsPerMinute;
	const groups = new Map<
		string,
		{
			id: string;
			candidates: DirectionZoomCandidate[];
			span: DirectionSpan;
			intentSpan: DirectionSpan;
			connectionMode: "bounded" | "renewable";
			minimumDurationExempt: boolean;
			score: number;
		}
	>();
	for (const [index, candidate] of options.candidates.entries()) {
		const key = candidate.sequenceId ?? `candidate-${index}`;
		const group = groups.get(key);
		if (group) {
			group.candidates.push(candidate);
			group.span.start = Math.min(
				group.span.start,
				candidate.sequenceSpan?.start ?? candidate.span.start,
			);
			group.span.end = Math.max(group.span.end, candidate.sequenceSpan?.end ?? candidate.span.end);
			group.intentSpan.start = Math.min(
				group.intentSpan.start,
				candidate.intentSpan?.start ?? candidate.span.start,
			);
			group.intentSpan.end = Math.max(
				group.intentSpan.end,
				candidate.intentSpan?.end ?? candidate.span.end,
			);
			if (candidate.connectionMode === "renewable") group.connectionMode = "renewable";
			if (candidate.minimumDurationExempt) group.minimumDurationExempt = true;
			group.score += candidate.score;
		} else {
			const intentSpan = candidate.intentSpan ?? candidate.sequenceSpan ?? candidate.span;
			groups.set(key, {
				id: key,
				candidates: [candidate],
				span: { ...(candidate.sequenceSpan ?? candidate.span) },
				intentSpan: { ...intentSpan },
				connectionMode: candidate.connectionMode ?? "bounded",
				minimumDurationExempt: candidate.minimumDurationExempt === true,
				score: candidate.score,
			});
		}
	}

	const selected: Array<{
		id: string;
		candidates: DirectionZoomCandidate[];
		span: DirectionSpan;
		intentSpan: DirectionSpan;
		connectionMode: "bounded" | "renewable";
	}> = [];
	for (const group of [...groups.values()].sort(
		(left, right) => right.score - left.score || left.span.start - right.span.start,
	)) {
		if (
			!group.minimumDurationExempt &&
			group.span.end - group.span.start < policy.minimumZoomDurationMs
		) {
			continue;
		}
		if (allOccupiedDirections.some((span) => spansOverlap(span, group.span))) continue;
		if (occupiedZooms.some((span) => gapBetween(span, group.span) < policy.minimumSpacingMs)) {
			continue;
		}
		if (selected.some((other) => spansOverlap(other.span, group.span))) continue;
		if (
			selected.some((other) => {
				const gap = gapBetween(other.span, group.span);
				return gap > policy.sequenceConnectionGapMs && gap < policy.minimumSpacingMs;
			})
		) {
			continue;
		}
		const nextScreenSequences = mergeOccupiedSequences(
			[
				...occupiedZooms,
				...selected.map((item) => ({ ...item.span, directionGroupId: item.id })),
				{ ...group.span, directionGroupId: group.id },
			],
			options.durationMs,
			policy.sequenceConnectionGapMs,
		);
		if (
			!staysWithinRollingSequenceBudget(
				nextScreenSequences,
				policy.maxZoomsPerMinute,
				budgetDurationMs,
			)
		) {
			continue;
		}
		const nextTotalSequences = [
			...nextScreenSequences,
			...mergeOccupiedSequences(occupiedDirections, options.durationMs, 0),
		];
		if (
			!staysWithinRollingSequenceBudget(
				nextTotalSequences,
				totalDirectionsPerMinute,
				budgetDurationMs,
			)
		) {
			continue;
		}
		selected.push(group);
	}
	return selected
		.flatMap((group) => group.candidates)
		.sort((left, right) => left.span.start - right.span.start);
}

export function buildDirectionPlan(options: {
	cursor: DirectionCursorSample[];
	focusActivities?: DirectionCursorSample[];
	durationMs: number;
	occupiedZooms?: DirectionSpan[];
	occupiedDirections?: DirectionSpan[];
	maximumTotalDirectionsPerMinute?: number;
	preferredZoomDurationMs?: number;
	policy?: DirectionPolicy;
	connectedClickPolicy?: ConnectedClickPolicy;
}): DirectionPlan {
	const durationMs = Math.max(0, options.durationMs);
	const policy = options.policy ?? DEFAULT_DIRECTION_POLICY;
	if (durationMs < policy.minimumZoomDurationMs) return { zooms: [] };
	const focusActivities = normalizeDirectionCursor(options.focusActivities ?? [], durationMs);
	const cursor = normalizeDirectionCursor(options.cursor, durationMs);
	if (cursor.length === 0 && focusActivities.length === 0) return { zooms: [] };

	const requestedDurationMs = options.preferredZoomDurationMs ?? policy.defaultZoomDurationMs;
	const preferredZoomDurationMs = clamp(
		Number.isFinite(requestedDurationMs) ? requestedDurationMs : policy.defaultZoomDurationMs,
		policy.minimumZoomDurationMs,
		policy.maximumZoomDurationMs,
	);
	const candidates = detectDirectionCandidates({
		cursor,
		...(focusActivities.length > 0 ? { focusActivities } : {}),
		durationMs,
		preferredZoomDurationMs,
		policy,
		...(options.connectedClickPolicy ? { connectedClickPolicy: options.connectedClickPolicy } : {}),
	});
	return {
		zooms: selectDirectionCandidates({
			candidates,
			durationMs,
			occupiedZooms: options.occupiedZooms,
			occupiedDirections: options.occupiedDirections,
			maximumTotalDirectionsPerMinute: options.maximumTotalDirectionsPerMinute,
			policy,
		}),
	};
}

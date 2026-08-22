import { getZoomScale, type ZoomRegion } from "@/components/video-editor/types";
import {
	TRANSITION_WINDOW_MS,
	ZOOM_IN_OVERLAP_MS,
	ZOOM_IN_TRANSITION_WINDOW_MS,
} from "@/lib/zoomMath/constants";
import type { MotionSpeed } from "@/lib/zoomMath/motionCurve";
import {
	CHAINED_ZOOM_PAN_GAP_MS,
	CONNECTED_ZOOM_PAN_DURATION_MS,
	findDominantRegion,
} from "@/lib/zoomMath/zoomRegionUtils";
import { computeZoomTransform } from "@/lib/zoomMath/zoomTransform";
import {
	AUTOMATIC_DIRECTION_MAX_SCALE,
	type ConnectedClickPolicy,
	DEFAULT_CONNECTED_CLICK_POLICY,
} from "./connected-click-policy";

const FOCUS_ACTIVITY_TYPES = new Set([
	"click",
	"double-click",
	"right-click",
	"middle-click",
	"typing",
	"drag-start",
	"drag-end",
]);
const UNIT_STAGE = { width: 1, height: 1 };
const UNIT_MASK = { x: 0, y: 0, width: 1, height: 1 };

export interface ConnectedClickSample {
	timeMs: number;
	cx: number;
	cy: number;
	visible?: boolean;
	interactionType?: string | null;
	directionExcluded?: boolean;
	/** Contribution to direction ranking. A complete typing burst contributes one unit. */
	directionWeight?: number;
	/** Stable identity for one renewable derived activity such as uninterrupted typing. */
	directionActivityId?: string;
	/** Bounded writing area that must drive framing instead of a parked pointer. */
	framingRect?: { x: number; y: number; width: number; height: number };
	/** Highlights center their full gesture bounds; typing only moves enough to keep its area visible. */
	framingMode?: "contain" | "center";
}

export interface ConnectedClickZoom {
	span: { start: number; end: number };
	focus: { cx: number; cy: number };
	customScale: number;
	motionSpeed: MotionSpeed;
}

export interface ConnectedClickSequence {
	id: string;
	span: { start: number; end: number };
	intentSpan: { start: number; end: number };
	/** Internal detector chains combined into this one visual passage. */
	detectorChainCount: number;
	renewable: boolean;
	containsDrag: boolean;
	clickCount: number;
	scoreWeight: number;
	resolvedScale: number;
	croppedFrames: number;
	paddedBreaches: number;
	zooms: ConnectedClickZoom[];
}

export interface ConnectedClickPlan {
	sequences: ConnectedClickSequence[];
	consumedSpans: Array<{ start: number; end: number }>;
}

type FocusTarget = {
	timeMs: number;
	cx: number;
	cy: number;
	count: number;
	interactionType?: string | null;
	directionActivityId?: string;
	framingRect?: { x: number; y: number; width: number; height: number };
	framingMode?: "contain" | "center";
};
type PanTransition = { startMs: number; endMs: number; motionSpeed: MotionSpeed };

const clamp = (value: number, minimum: number, maximum: number) =>
	Math.min(maximum, Math.max(minimum, value));
const lerp = (start: number, end: number, amount: number) => start + (end - start) * amount;
const distance = (left: { cx: number; cy: number }, right: { cx: number; cy: number }) =>
	Math.hypot(left.cx - right.cx, left.cy - right.cy);

function lowerBoundSampleTime(samples: ConnectedClickSample[], timeMs: number) {
	let low = 0;
	let high = samples.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (samples[middle].timeMs < timeMs) low = middle + 1;
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

function samplesAroundInterval(samples: ConnectedClickSample[], startMs: number, endMs: number) {
	const first = Math.max(0, lowerBoundSampleTime(samples, startMs) - 1);
	let afterLast = lowerBoundSampleTime(samples, endMs);
	while (afterLast < samples.length && samples[afterLast].timeMs <= endMs) afterLast += 1;
	afterLast = Math.min(samples.length, afterLast + 1);
	return samples.slice(first, afterLast);
}

function collapseClicks(samples: ConnectedClickSample[], policy: ConnectedClickPolicy) {
	const collapsed: ConnectedClickSample[] = [];
	for (const click of samples.filter(
		(sample) =>
			sample.visible !== false &&
			!sample.directionExcluded &&
			FOCUS_ACTIVITY_TYPES.has(sample.interactionType ?? ""),
	)) {
		const previous = collapsed.at(-1);
		const crossesDerivedActivity = Boolean(
			previous?.directionActivityId &&
				click.directionActivityId &&
				previous.directionActivityId !== click.directionActivityId,
		);
		const followsCompletedDrag = Boolean(
			previous?.directionActivityId?.startsWith("drag-") &&
				click.directionActivityId !== previous.directionActivityId,
		);
		if (
			previous &&
			!crossesDerivedActivity &&
			!followsCompletedDrag &&
			click.timeMs - previous.timeMs <= policy.clickDedupeMs &&
			distance(click, previous) <= policy.clickDedupeDistance
		) {
			if (click.directionActivityId) {
				previous.directionActivityId = click.directionActivityId;
			}
			if (click.interactionType !== previous.interactionType) {
				previous.directionWeight = (previous.directionWeight ?? 1) + (click.directionWeight ?? 1);
			}
			if (click.framingRect) {
				previous.framingRect = click.framingRect;
				previous.framingMode = click.framingMode ?? "contain";
				previous.cx = click.cx;
				previous.cy = click.cy;
			}
			continue;
		}
		collapsed.push(click);
	}
	return collapsed;
}

function makeChains(
	clicks: ConnectedClickSample[],
	samples: ConnectedClickSample[],
	policy: ConnectedClickPolicy,
) {
	if (clicks.length === 0) return [];
	const blockers = samples
		.filter((sample) => sample.visible === false || sample.directionExcluded)
		.map((sample) => sample.timeMs);
	const chains: ConnectedClickSample[][] = [];
	let current = [clicks[0]];
	let currentActivityId = clicks[0].directionActivityId;
	for (const click of clicks.slice(1)) {
		const previous = current.at(-1)!;
		const gap = click.timeMs - previous.timeMs;
		const duration = click.timeMs - current[0].timeMs;
		let blockerIndex = lowerBoundNumber(blockers, previous.timeMs);
		while (blockers[blockerIndex] <= previous.timeMs) blockerIndex += 1;
		const crossesBlockedInterval = blockers[blockerIndex] < click.timeMs;
		const crossesActivityBoundary = Boolean(
			currentActivityId &&
				click.directionActivityId &&
				currentActivityId !== click.directionActivityId,
		);
		const renewsDerivedActivity = Boolean(
			(click.directionActivityId && click.directionActivityId === currentActivityId) ||
				(previous.interactionType === "typing" && click.interactionType !== "typing"),
		);
		const continuesDrag = Boolean(
			currentActivityId?.startsWith("drag-") &&
				click.directionActivityId === currentActivityId &&
				gap <= policy.dragMaximumDurationMs,
		);
		if (
			!crossesBlockedInterval &&
			!crossesActivityBoundary &&
			(gap <= policy.chainGapMs || continuesDrag) &&
			(renewsDerivedActivity || duration <= policy.clickChainMaximumDurationMs)
		) {
			current.push(click);
			currentActivityId = click.directionActivityId ?? currentActivityId;
		} else {
			chains.push(current);
			current = [click];
			currentActivityId = click.directionActivityId;
		}
	}
	chains.push(current);
	return chains;
}

function mergeTargets(clicks: ConnectedClickSample[], policy: ConnectedClickPolicy) {
	const targets: FocusTarget[] = [];
	for (const click of clicks) {
		const previous = targets.at(-1);
		const followsCompletedDrag = Boolean(
			previous?.directionActivityId?.startsWith("drag-") &&
				click.directionActivityId !== previous.directionActivityId,
		);
		if (
			previous &&
			!followsCompletedDrag &&
			click.timeMs - previous.timeMs <= policy.targetMergeMs &&
			distance(click, previous) <= policy.targetMergeDistance
		) {
			const renewsTypingTarget =
				previous.interactionType === "typing" &&
				click.interactionType === "typing" &&
				Boolean(previous.directionActivityId) &&
				previous.directionActivityId === click.directionActivityId;
			previous.cx = click.framingRect
				? click.framingRect.x + click.framingRect.width / 2
				: (previous.cx * previous.count + click.cx) / (previous.count + 1);
			previous.cy = click.framingRect
				? click.framingRect.y + click.framingRect.height / 2
				: (previous.cy * previous.count + click.cy) / (previous.count + 1);
			if (!renewsTypingTarget) previous.timeMs = click.timeMs;
			previous.count += 1;
			previous.interactionType = click.interactionType;
			previous.directionActivityId = click.directionActivityId ?? previous.directionActivityId;
			if (click.framingRect) {
				previous.framingRect = click.framingRect;
				previous.framingMode = click.framingMode ?? "contain";
			}
		} else {
			targets.push({
				timeMs: click.timeMs,
				cx: click.cx,
				cy: click.cy,
				count: 1,
				interactionType: click.interactionType,
				...(click.directionActivityId ? { directionActivityId: click.directionActivityId } : {}),
				...(click.framingRect ? { framingRect: click.framingRect } : {}),
				...(click.framingMode ? { framingMode: click.framingMode } : {}),
			});
		}
	}
	return targets;
}

function clampFocus(focus: { cx: number; cy: number }, scale: number) {
	const half = 0.5 / Math.max(1, scale);
	return {
		cx: clamp(focus.cx, half, 1 - half),
		cy: clamp(focus.cy, half, 1 - half),
	};
}

function focusContainingRect(
	current: { cx: number; cy: number },
	rect: NonNullable<FocusTarget["framingRect"]>,
	scale: number,
	policy: ConnectedClickPolicy,
) {
	const safeHalf = (0.5 / Math.max(1, scale)) * (1 - clamp(policy.safeInset, 0, 0.95));
	const fitAxis = (position: number, minimum: number, maximum: number) => {
		const lower = maximum - safeHalf;
		const upper = minimum + safeHalf;
		return lower <= upper ? clamp(position, lower, upper) : (minimum + maximum) / 2;
	};
	return clampFocus(
		{
			cx: fitAxis(current.cx, rect.x, rect.x + rect.width),
			cy: fitAxis(current.cy, rect.y, rect.y + rect.height),
		},
		scale,
	);
}

function makeFocusTargets(
	clicks: ConnectedClickSample[],
	scale: number,
	policy: ConnectedClickPolicy,
	initialFocus?: { cx: number; cy: number },
) {
	let focus = clampFocus(initialFocus ?? { cx: 0.5, cy: 0.5 }, scale);
	const targets: FocusTarget[] = [];
	for (const target of mergeTargets(clicks, policy)) {
		if (target.framingRect) {
			const framed =
				target.framingMode === "center"
					? clampFocus(
							{
								cx: target.framingRect.x + target.framingRect.width / 2,
								cy: target.framingRect.y + target.framingRect.height / 2,
							},
							scale,
						)
					: focusContainingRect(focus, target.framingRect, scale, policy);
			if (targets.length === 0 || distance(focus, framed) > policy.minimumFocusChangeDistance) {
				targets.push({ ...target, ...framed });
			}
			focus = framed;
			continue;
		}
		const halfWidth = policy.deadZoneWidthRatio / (2 * scale);
		const halfHeight = policy.deadZoneHeightRatio / (2 * scale);
		const next = { ...focus };
		if (target.cx < focus.cx - halfWidth) next.cx = target.cx + halfWidth;
		else if (target.cx > focus.cx + halfWidth) next.cx = target.cx - halfWidth;
		if (target.cy < focus.cy - halfHeight) next.cy = target.cy + halfHeight;
		else if (target.cy > focus.cy + halfHeight) next.cy = target.cy - halfHeight;
		const clamped = clampFocus(next, scale);
		if (targets.length === 0 || distance(focus, clamped) > policy.minimumFocusChangeDistance) {
			targets.push({ ...target, ...clamped });
		}
		focus = clamped;
	}
	return targets;
}

function panMotionSpeed(
	left: FocusTarget,
	right: FocusTarget,
	policy: ConnectedClickPolicy,
): MotionSpeed {
	const progress = clamp(
		distance(left, right) / Math.max(Number.EPSILON, policy.panDistanceForMaximum),
		0,
		1,
	);
	const desiredMs = lerp(policy.minimumPanMs, policy.maximumPanMs, progress);
	const connectedSpeeds = policy.panMotionSpeeds.filter(
		(speed) => CONNECTED_ZOOM_PAN_DURATION_MS / speed <= CHAINED_ZOOM_PAN_GAP_MS,
	);
	const speeds: readonly MotionSpeed[] = connectedSpeeds.length > 0 ? connectedSpeeds : [1];
	return speeds.reduce((best, speed) =>
		Math.abs(CONNECTED_ZOOM_PAN_DURATION_MS / speed - desiredMs) <
		Math.abs(CONNECTED_ZOOM_PAN_DURATION_MS / best - desiredMs)
			? speed
			: best,
	);
}

function makeTransitions(
	targets: FocusTarget[],
	activeStartMs: number,
	policy: ConnectedClickPolicy,
): PanTransition[] {
	let targetStartMs = activeStartMs;
	return targets.slice(1).map((target, index) => {
		const previous = targets[index];
		const continuesDrag = Boolean(
			previous.directionActivityId?.startsWith("drag-") &&
				previous.directionActivityId === target.directionActivityId,
		);
		const connectedDragSpeeds = policy.panMotionSpeeds.filter(
			(speed) => CONNECTED_ZOOM_PAN_DURATION_MS / speed <= CHAINED_ZOOM_PAN_GAP_MS,
		);
		const motionSpeed = continuesDrag
			? connectedDragSpeeds.reduce(
					(fastest, speed) => (speed > fastest ? speed : fastest),
					1 as MotionSpeed,
				)
			: panMotionSpeed(previous, target, policy);
		const durationMs = CONNECTED_ZOOM_PAN_DURATION_MS / motionSpeed;
		const desiredEndMs = target.timeMs - policy.anticipationMs;
		const normalStartMs = Math.max(
			desiredEndMs - durationMs,
			targetStartMs + policy.minimumTargetHoldMs,
		);
		const dragEarliestMs = Math.max(previous.timeMs, targetStartMs + policy.minimumTargetHoldMs);
		const dragLatestMs = Math.max(dragEarliestMs, target.timeMs - durationMs);
		const dragCenteredMs = (previous.timeMs + target.timeMs - durationMs) / 2;
		const startMs = continuesDrag
			? clamp(dragCenteredMs, dragEarliestMs, dragLatestMs)
			: normalStartMs;
		const endMs = startMs + durationMs;
		targetStartMs = endMs;
		return { startMs, endMs, motionSpeed };
	});
}

function makeZooms(
	clicks: ConnectedClickSample[],
	durationMs: number,
	scale: number,
	policy: ConnectedClickPolicy,
	initialFocus?: { cx: number; cy: number },
): ConnectedClickZoom[] | null {
	const targets = makeFocusTargets(clicks, scale, policy, initialFocus);
	if (targets.length === 0) return null;
	const activeStartMs = Math.max(0, clicks[0].timeMs - policy.leadBeforeFirstClickMs);
	const transitions = makeTransitions(targets, activeStartMs, policy);
	const starts = [activeStartMs, ...transitions.map((transition) => transition.endMs)];
	const requestedEndMs = clicks.at(-1)!.timeMs + policy.holdAfterLastClickMs;
	const activeEndMs = Math.min(
		durationMs,
		Math.max(requestedEndMs, starts.at(-1)! + policy.minimumTargetHoldMs),
	);
	if (starts.at(-1)! + policy.minimumTargetHoldMs > activeEndMs) return null;

	return targets.map((target, index) => ({
		span: {
			start: Math.round(starts[index]),
			end: Math.round(transitions[index]?.startMs ?? activeEndMs),
		},
		focus: { cx: target.cx, cy: target.cy },
		customScale: scale,
		motionSpeed: transitions[index - 1]?.motionSpeed ?? policy.entryMotionSpeed,
	}));
}

function cursorAt(samples: ConnectedClickSample[], timeMs: number) {
	const low = lowerBoundSampleTime(samples, timeMs);
	if (low <= 0) return samples[0];
	if (low >= samples.length) return samples.at(-1)!;
	const previous = samples[low - 1];
	const next = samples[low];
	if (next.timeMs === timeMs) return next;
	const progress = (timeMs - previous.timeMs) / Math.max(1, next.timeMs - previous.timeMs);
	return {
		timeMs,
		cx: lerp(previous.cx, next.cx, progress),
		cy: lerp(previous.cy, next.cy, progress),
		visible: previous.visible !== false && next.visible !== false,
		directionExcluded: previous.directionExcluded || next.directionExcluded,
	};
}

function safetyForZooms(
	zooms: ConnectedClickZoom[],
	samples: ConnectedClickSample[],
	focusActivities: ConnectedClickSample[],
	policy: ConnectedClickPolicy,
) {
	const regions: ZoomRegion[] = zooms.map((zoom, index) => ({
		id: `connected-safety-${index}`,
		startMs: zoom.span.start,
		endMs: zoom.span.end,
		depth: 3,
		focus: zoom.focus,
		focusMode: "manual",
		customScale: zoom.customScale,
		motionStyle: "smooth",
		motionSpeed: zoom.motionSpeed,
	}));
	const first = regions[0];
	const last = regions.at(-1)!;
	const startMs = Math.max(
		0,
		first.startMs + ZOOM_IN_OVERLAP_MS - ZOOM_IN_TRANSITION_WINDOW_MS / (first.motionSpeed ?? 1),
	);
	const endMs = last.endMs + TRANSITION_WINDOW_MS / (last.motionSpeed ?? 1);
	const activeSamples = samplesAroundInterval(samples, startMs, endMs);
	const requestedSafetyFps = Number.isFinite(policy.safetyFramesPerSecond)
		? policy.safetyFramesPerSecond
		: 60;
	const stepMs = 1_000 / Math.max(60, requestedSafetyFps);
	const safeInset = clamp(policy.safeInset, 0, 0.95);
	let croppedFrames = 0;
	let paddedBreaches = 0;
	const typingRanges = new Map<string, { start: number; end: number }>();
	for (const [index, sample] of focusActivities.entries()) {
		if (sample.interactionType !== "typing") continue;
		const key = sample.directionActivityId ?? `typing-sample-${index}`;
		const range = typingRanges.get(key);
		const sampleStart = sample.timeMs - policy.leadBeforeFirstClickMs;
		const sampleEnd = sample.timeMs + policy.holdAfterLastClickMs;
		if (range) {
			range.start = Math.min(range.start, sampleStart);
			range.end = Math.max(range.end, sampleEnd);
		} else {
			typingRanges.set(key, { start: sampleStart, end: sampleEnd });
		}
	}
	if (
		focusActivities.length > 0 &&
		focusActivities.every((sample) => sample.interactionType === "typing")
	) {
		typingRanges.set("typing-only-visual-window", { start: startMs, end: endMs });
	}
	for (const activity of focusActivities) {
		if (!activity.framingRect) continue;
		const zoom =
			[...zooms].reverse().find((candidate) => candidate.span.start <= activity.timeMs) ?? zooms[0];
		const half = 0.5 / Math.max(1, zoom.customScale);
		const paddedHalf = half * (1 - safeInset);
		const focus = clampFocus(zoom.focus, zoom.customScale);
		const rect = activity.framingRect;
		const outsideVisible =
			rect.x < focus.cx - half - 1e-6 ||
			rect.x + rect.width > focus.cx + half + 1e-6 ||
			rect.y < focus.cy - half - 1e-6 ||
			rect.y + rect.height > focus.cy + half + 1e-6;
		const outsidePadding =
			rect.x < focus.cx - paddedHalf - 1e-6 ||
			rect.x + rect.width > focus.cx + paddedHalf + 1e-6 ||
			rect.y < focus.cy - paddedHalf - 1e-6 ||
			rect.y + rect.height > focus.cy + paddedHalf + 1e-6;
		if (outsideVisible) croppedFrames += 1;
		if (outsidePadding) paddedBreaches += 1;
	}
	const safetyTimes = new Set<number>([startMs, endMs]);
	for (
		let timeMs = Math.ceil(startMs / stepMs) * stepMs;
		timeMs <= endMs + 0.01;
		timeMs += stepMs
	) {
		safetyTimes.add(timeMs);
	}
	for (const sample of activeSamples) {
		if (sample.timeMs >= startMs && sample.timeMs <= endMs) safetyTimes.add(sample.timeMs);
	}
	for (const timeMs of [...safetyTimes].sort((left, right) => left - right)) {
		if ([...typingRanges.values()].some((range) => timeMs >= range.start && timeMs <= range.end)) {
			continue;
		}
		if (activeSamples.length === 0) continue;
		const cursor = cursorAt(activeSamples, timeMs);
		if (cursor.visible === false || cursor.directionExcluded) continue;
		const dominant = findDominantRegion(regions, timeMs, { connectZooms: true });
		if (!dominant.region || dominant.strength <= 0) continue;
		const zoomScale = dominant.blendedScale ?? getZoomScale(dominant.region);
		const transform = computeZoomTransform({
			stageSize: UNIT_STAGE,
			baseMask: UNIT_MASK,
			zoomScale,
			zoomProgress: dominant.strength,
			focusX: dominant.region.focus.cx,
			focusY: dominant.region.focus.cy,
		});
		const centerX = (0.5 - transform.x) / transform.scale;
		const centerY = (0.5 - transform.y) / transform.scale;
		const visibleHalf = 0.5 / transform.scale;
		const paddedHalf = visibleHalf * (1 - safeInset);
		const deltaX = Math.abs(cursor.cx - centerX);
		const deltaY = Math.abs(cursor.cy - centerY);
		if (deltaX > visibleHalf + 1e-6 || deltaY > visibleHalf + 1e-6) croppedFrames += 1;
		if (deltaX > paddedHalf + 1e-6 || deltaY > paddedHalf + 1e-6) paddedBreaches += 1;
	}
	return { croppedFrames, paddedBreaches };
}

function solveSequence(
	clicks: ConnectedClickSample[],
	samples: ConnectedClickSample[],
	durationMs: number,
	policy: ConnectedClickPolicy,
	initialFocus?: { cx: number; cy: number },
) {
	const evaluate = (scale: number) => {
		const zooms = makeZooms(clicks, durationMs, scale, policy, initialFocus);
		return zooms ? { scale, zooms, ...safetyForZooms(zooms, samples, clicks, policy) } : null;
	};
	const requestedScale = clamp(policy.requestedScale, 1, AUTOMATIC_DIRECTION_MAX_SCALE);
	const requested = evaluate(requestedScale);
	if (!requested || requested.paddedBreaches === 0) return requested;
	const fullFrame = evaluate(1);
	if (!fullFrame) return null;
	const safetyKey = fullFrame.paddedBreaches === 0 ? "paddedBreaches" : "croppedFrames";
	if (requested[safetyKey] === 0) return requested;

	let safeScale = 1;
	let unsafeScale = requestedScale;
	let safest = fullFrame;
	const iterations = Math.max(0, Math.floor(policy.scaleSearchIterations));
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const candidate = evaluate((safeScale + unsafeScale) / 2);
		if (candidate && candidate[safetyKey] === 0) {
			safeScale = candidate.scale;
			safest = candidate;
		} else {
			unsafeScale = candidate?.scale ?? unsafeScale;
		}
	}
	return safest;
}

function makeVisualPassages(
	chains: ConnectedClickSample[][],
	durationMs: number,
	policy: ConnectedClickPolicy,
) {
	const passages: ConnectedClickSample[][][] = [];
	for (const chain of chains) {
		const passage = passages.at(-1);
		const previous = passage?.at(-1);
		if (!previous) {
			passages.push([chain]);
			continue;
		}
		const previousEndMs = Math.min(
			durationMs,
			previous.at(-1)!.timeMs + policy.holdAfterLastClickMs,
		);
		const currentStartMs = Math.max(0, chain[0].timeMs - policy.leadBeforeFirstClickMs);
		if (currentStartMs - previousEndMs <= policy.passageConnectionGapMs) {
			passage!.push(chain);
		} else {
			passages.push([chain]);
		}
	}
	return passages;
}

function makeShortDragDestinationActivities(
	clicks: ConnectedClickSample[],
	policy: ConnectedClickPolicy,
) {
	const connectedSpeeds = policy.panMotionSpeeds.filter(
		(speed) => CONNECTED_ZOOM_PAN_DURATION_MS / speed <= CHAINED_ZOOM_PAN_GAP_MS,
	);
	const fastestSpeed = connectedSpeeds.reduce(
		(fastest, speed) => (speed > fastest ? speed : fastest),
		1 as MotionSpeed,
	);
	const minimumPanDurationMs = CONNECTED_ZOOM_PAN_DURATION_MS / fastestSpeed;
	const visibleEntryLeadMs = Math.max(
		0,
		ZOOM_IN_TRANSITION_WINDOW_MS / policy.entryMotionSpeed - ZOOM_IN_OVERLAP_MS,
	);
	const shortDrags: Array<{ activityId: string; endIndex: number; targetTimeMs: number }> = [];
	for (const [endIndex, sample] of clicks.entries()) {
		const activityId = sample.directionActivityId;
		if (!activityId?.startsWith("drag-") || sample.interactionType !== "drag-end") continue;
		const start = clicks.find((candidate) => candidate.directionActivityId === activityId);
		if (!start || sample.timeMs - start.timeMs >= minimumPanDurationMs) continue;
		shortDrags.push({
			activityId,
			endIndex,
			targetTimeMs:
				sample.timeMs +
				policy.leadBeforeFirstClickMs +
				visibleEntryLeadMs +
				policy.shortDragDestinationDelayMs,
		});
	}
	if (shortDrags.length === 0) return null;
	const consumedIndices = new Set<number>();
	const destinations: ConnectedClickSample[] = [];
	for (const drag of shortDrags) {
		for (const [index, sample] of clicks.entries()) {
			if (sample.directionActivityId === drag.activityId) consumedIndices.add(index);
		}
		const quickFollowups = clicks
			.map((sample, index) => ({ sample, index }))
			.filter(
				({ sample, index }) =>
					index > drag.endIndex &&
					sample.timeMs <= drag.targetTimeMs &&
					!sample.directionActivityId?.startsWith("drag-"),
			);
		for (const followup of quickFollowups) consumedIndices.add(followup.index);
		const source = quickFollowups.at(-1)?.sample ?? clicks[drag.endIndex];
		destinations.push({
			...source,
			timeMs: drag.targetTimeMs,
			...(source === clicks[drag.endIndex] ? { framingRect: undefined } : {}),
		});
	}
	return [...clicks.filter((_, index) => !consumedIndices.has(index)), ...destinations].sort(
		(left, right) => left.timeMs - right.timeMs,
	);
}

/**
 * Choose the simplest safe framing for a complete visual passage. Internal
 * detector splits must not become scale pulses. Prefer fewer focus changes
 * inside the useful stable-scale range, then keep the deepest safe scale.
 */
function solveVisualPassage(
	clicks: ConnectedClickSample[],
	samples: ConnectedClickSample[],
	durationMs: number,
	policy: ConnectedClickPolicy,
	initialFocus?: { cx: number; cy: number },
) {
	const solveLayout = (activities: ConnectedClickSample[]) => {
		const evaluate = (scale: number) => {
			const zooms = makeZooms(activities, durationMs, scale, policy, initialFocus);
			return zooms ? { scale, zooms, ...safetyForZooms(zooms, samples, activities, policy) } : null;
		};
		const fullFrame = evaluate(1);
		if (!fullFrame) return null;
		const safetyKey = fullFrame.paddedBreaches === 0 ? "paddedBreaches" : "croppedFrames";
		const maximumScale = clamp(policy.requestedScale, 1, AUTOMATIC_DIRECTION_MAX_SCALE);
		const minimumScale = clamp(policy.passageMinimumStableScale, 1, maximumScale);
		const steps = Math.max(1, Math.floor(policy.passageScaleSearchSteps));
		const candidates = Array.from({ length: steps + 1 }, (_, index) =>
			evaluate(maximumScale - ((maximumScale - minimumScale) * index) / steps),
		).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
		const safeCandidates = candidates.filter((candidate) => candidate[safetyKey] === 0);
		if (safeCandidates.length > 0) {
			const minimumTargets = Math.min(...safeCandidates.map((candidate) => candidate.zooms.length));
			return safeCandidates
				.filter((candidate) => candidate.zooms.length === minimumTargets)
				.sort((left, right) => right.scale - left.scale)[0];
		}
		// Keep the useful-depth floor when it still contains every real cursor
		// position. A padding breach is preferable to an almost invisible Zoom;
		// an actual cropped frame is never accepted.
		const hardSafeCandidates = candidates.filter((candidate) => candidate.croppedFrames === 0);
		if (hardSafeCandidates.length > 0) {
			const minimumTargets = Math.min(
				...hardSafeCandidates.map((candidate) => candidate.zooms.length),
			);
			return hardSafeCandidates
				.filter((candidate) => candidate.zooms.length === minimumTargets)
				.sort((left, right) => right.scale - left.scale)[0];
		}
		return solveSequence(activities, samples, durationMs, policy);
	};

	const stable = solveLayout(clicks);
	if (!stable) return stable;
	const hasDrag = clicks.some((sample) => sample.directionActivityId?.startsWith("drag-"));
	const centersFraming = clicks.some(
		(sample) => sample.framingRect && sample.framingMode === "center",
	);
	if (
		!hasDrag ||
		stable.scale >= policy.passageMinimumStableScale ||
		(centersFraming && stable.scale >= policy.minimumUsefulScale)
	) {
		return stable;
	}
	const pannedActivities = clicks.map((sample) =>
		sample.directionActivityId?.startsWith("drag-")
			? { ...sample, framingRect: undefined }
			: sample,
	);
	const panned = solveLayout(pannedActivities);
	if (panned && panned.scale >= policy.passageMinimumStableScale) return panned;
	const bestPanned = panned && panned.scale > stable.scale ? panned : stable;
	const destinationActivities = makeShortDragDestinationActivities(clicks, policy);
	if (!destinationActivities) return bestPanned;
	const destination = solveLayout(destinationActivities);
	return destination && destination.scale > bestPanned.scale ? destination : bestPanned;
}

type SolvedVisualPassage = NonNullable<ReturnType<typeof solveVisualPassage>>;

function passagePointerActivities(
	detectorChains: ConnectedClickSample[][],
	samples: ConnectedClickSample[],
) {
	const intents = detectorChains.flat();
	const startMs = intents[0].timeMs;
	const endMs = intents.at(-1)!.timeMs;
	const activities = samples.filter(
		(sample) =>
			sample.timeMs >= startMs &&
			sample.timeMs <= endMs &&
			sample.visible !== false &&
			!sample.directionExcluded,
	);
	for (const intent of intents) {
		const matchingIndex = activities.findIndex(
			(sample) =>
				sample.timeMs === intent.timeMs &&
				Math.abs(sample.cx - intent.cx) < 1e-6 &&
				Math.abs(sample.cy - intent.cy) < 1e-6,
		);
		if (matchingIndex >= 0) activities[matchingIndex] = intent;
		else activities.push(intent);
	}
	return activities.sort((left, right) => left.timeMs - right.timeMs);
}

/**
 * Keep one coherent passage when it has a useful safe crop. If the complete
 * passage can only produce a weak crop, split at detector-chain boundaries and
 * solve the largest useful consecutive groups. A detector chain is never split,
 * so one drag or renewable typing activity keeps its complete intent.
 */
function solveStablePassageGroups(
	detectorChains: ConnectedClickSample[][],
	samples: ConnectedClickSample[],
	durationMs: number,
	policy: ConnectedClickPolicy,
): Array<{ detectorChains: ConnectedClickSample[][]; solved: SolvedVisualPassage }> {
	const whole = solveVisualPassage(detectorChains.flat(), samples, durationMs, policy);
	if (!whole) return [];
	if (detectorChains.length === 1 || whole.scale >= policy.passageMinimumStableScale) {
		return [{ detectorChains, solved: whole }];
	}

	// Movement does not create a passage by itself. Inside an already qualified
	// passage, it can add the minimum intermediate targets needed to keep the
	// real cursor on screen while the crop pans between interaction targets.
	const followed = solveVisualPassage(
		passagePointerActivities(detectorChains, samples),
		samples,
		durationMs,
		policy,
	);
	if (
		followed &&
		followed.scale >= policy.passageMinimumStableScale &&
		followed.croppedFrames === 0
	) {
		return [{ detectorChains, solved: followed }];
	}

	const groups: Array<{
		detectorChains: ConnectedClickSample[][];
		solved: SolvedVisualPassage;
	}> = [];
	let currentChains: ConnectedClickSample[][] = [];
	let currentSolved: SolvedVisualPassage | null = null;
	let initialFocus: { cx: number; cy: number } | undefined;
	for (const detectorChain of detectorChains) {
		const candidateChains = [...currentChains, detectorChain];
		const candidateSolved = solveVisualPassage(
			candidateChains.flat(),
			samples,
			durationMs,
			policy,
			initialFocus,
		);
		if (
			currentChains.length === 0 ||
			(candidateSolved && candidateSolved.scale >= policy.passageMinimumStableScale)
		) {
			currentChains = candidateChains;
			currentSolved = candidateSolved;
			continue;
		}

		if (currentSolved) {
			groups.push({ detectorChains: currentChains, solved: currentSolved });
			initialFocus = currentSolved.zooms.at(-1)?.focus;
		}
		currentChains = [detectorChain];
		currentSolved = solveVisualPassage(detectorChain, samples, durationMs, policy, initialFocus);
	}
	if (currentSolved) groups.push({ detectorChains: currentChains, solved: currentSolved });
	for (let index = 1; index < groups.length; index += 1) {
		const previous = groups[index - 1];
		const current = groups[index];
		const previousZoom = previous.solved.zooms.at(-1)!;
		const currentZoom = current.solved.zooms[0];
		if (previousZoom.span.end <= currentZoom.span.start) continue;
		const currentIntentMs = current.detectorChains[0][0].timeMs;
		const motionSpeed = panMotionSpeed(
			{ ...previousZoom.focus, timeMs: previousZoom.span.end, count: 1 },
			{ ...currentZoom.focus, timeMs: currentIntentMs, count: 1 },
			policy,
		);
		const transitionMs = CONNECTED_ZOOM_PAN_DURATION_MS / motionSpeed;
		let nextStartMs = Math.max(currentZoom.span.start, currentIntentMs - policy.anticipationMs);
		let previousEndMs = nextStartMs - transitionMs;
		const earliestPreviousEnd = previousZoom.span.start + policy.minimumTargetHoldMs;
		if (previousEndMs < earliestPreviousEnd) {
			previousEndMs = earliestPreviousEnd;
			nextStartMs = previousEndMs + transitionMs;
		}
		if (nextStartMs + policy.minimumTargetHoldMs > currentZoom.span.end) continue;
		previousZoom.span.end = Math.round(previousEndMs);
		currentZoom.span.start = Math.round(nextStartMs);
		currentZoom.motionSpeed = motionSpeed;
	}
	const hasUnresolvedOverlap = groups.some((group, index) => {
		if (index === 0) return false;
		return groups[index - 1].solved.zooms.at(-1)!.span.end > group.solved.zooms[0].span.start;
	});
	const containsTyping = detectorChains
		.flat()
		.some((sample) => sample.directionActivityId?.startsWith("typing-"));
	let hasUnresolvedUnsafeHandoff = false;
	if (!hasUnresolvedOverlap && containsTyping) {
		for (let index = 1; index < groups.length; index += 1) {
			const previous = groups[index - 1];
			const current = groups[index];
			const pairSafety = safetyForZooms(
				[...previous.solved.zooms, ...current.solved.zooms],
				samples,
				[...previous.detectorChains.flat(), ...current.detectorChains.flat()],
				policy,
			);
			if (pairSafety.croppedFrames === 0) continue;

			// A connected pan that would crop the real cursor is not a valid handoff.
			// Keep both locally safe groups and insert the smallest renderer-level
			// disconnect instead of flattening the complete visual passage.
			const previousZoom = previous.solved.zooms.at(-1)!;
			const currentZoom = current.solved.zooms[0];
			let missingGapMs = Math.max(
				0,
				CHAINED_ZOOM_PAN_GAP_MS + 1 - (currentZoom.span.start - previousZoom.span.end),
			);
			const currentIntentMs = current.detectorChains[0][0].timeMs;
			const latestCurrentStart = Math.min(
				currentIntentMs,
				currentZoom.span.end - policy.minimumTargetHoldMs,
			);
			const delayedStartMs = Math.min(
				missingGapMs,
				Math.max(0, latestCurrentStart - currentZoom.span.start),
			);
			currentZoom.span.start += delayedStartMs;
			missingGapMs -= delayedStartMs;

			const previousIntentMs = previous.detectorChains.at(-1)!.at(-1)!.timeMs;
			const earliestPreviousEnd = Math.max(
				previousIntentMs + policy.minimumTargetHoldMs,
				previousZoom.span.start + policy.minimumTargetHoldMs,
			);
			const shortenedEndMs = Math.min(
				missingGapMs,
				Math.max(0, previousZoom.span.end - earliestPreviousEnd),
			);
			previousZoom.span.end -= shortenedEndMs;
			missingGapMs -= shortenedEndMs;

			if (missingGapMs > 0) {
				hasUnresolvedUnsafeHandoff = true;
				break;
			}
		}
	}
	const combinedSafety = safetyForZooms(
		groups.flatMap((group) => group.solved.zooms),
		samples,
		detectorChains.flat(),
		policy,
	);
	if (hasUnresolvedOverlap || hasUnresolvedUnsafeHandoff || combinedSafety.croppedFrames > 0) {
		return whole.croppedFrames === 0 ? [{ detectorChains, solved: whole }] : [];
	}
	return groups;
}

export function planConnectedClickChains(options: {
	cursor: ConnectedClickSample[];
	focusActivities?: ConnectedClickSample[];
	durationMs: number;
	policy?: ConnectedClickPolicy;
}): ConnectedClickPlan {
	const policy = options.policy ?? DEFAULT_CONNECTED_CLICK_POLICY;
	const samples = options.cursor
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy) &&
				sample.timeMs >= 0 &&
				sample.timeMs <= options.durationMs,
		)
		.map((sample) => ({ ...sample, cx: clamp(sample.cx, 0, 1), cy: clamp(sample.cy, 0, 1) }))
		.sort((left, right) => left.timeMs - right.timeMs);
	const focusActivities = (options.focusActivities ?? [])
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy) &&
				sample.timeMs >= 0 &&
				sample.timeMs <= options.durationMs,
		)
		.map((sample) => ({ ...sample, cx: clamp(sample.cx, 0, 1), cy: clamp(sample.cy, 0, 1) }));
	const focusSamples = [
		...samples.filter((sample) => FOCUS_ACTIVITY_TYPES.has(sample.interactionType ?? "")),
		...focusActivities,
	].sort((left, right) => left.timeMs - right.timeMs);
	const detectorChains = makeChains(collapseClicks(focusSamples, policy), samples, policy);
	const passages = makeVisualPassages(detectorChains, options.durationMs, policy).filter(
		(passage) => passage.some((chain) => chain.length >= 2),
	);
	const consumedChains = passages.flat();
	const consumedSpans = consumedChains.map((chain) => ({
		start: chain[0].timeMs,
		end: chain.at(-1)!.timeMs,
	}));
	const solvedSequences: ConnectedClickSequence[] = [];
	for (const [passageIndex, detectorChains] of passages.entries()) {
		const groups = solveStablePassageGroups(detectorChains, samples, options.durationMs, policy);
		for (const [groupIndex, group] of groups.entries()) {
			const passage = group.detectorChains.flat();
			const solved = group.solved;
			if (solved.scale < policy.minimumUsefulScale) continue;
			solvedSequences.push({
				id: `connected-click-${passage[0].timeMs}-${passage.at(-1)!.timeMs}-${passageIndex}-${groupIndex}`,
				intentSpan: { start: passage[0].timeMs, end: passage.at(-1)!.timeMs },
				detectorChainCount: group.detectorChains.length,
				renewable: passage.some((sample) => sample.directionActivityId?.startsWith("typing-")),
				span: {
					start: solved.zooms[0].span.start,
					end: solved.zooms.at(-1)!.span.end,
				},
				clickCount: passage.length,
				containsDrag: passage.some((sample) => sample.directionActivityId?.startsWith("drag-")),
				scoreWeight: passage.reduce((total, sample) => total + (sample.directionWeight ?? 1), 0),
				resolvedScale: solved.scale,
				croppedFrames: solved.croppedFrames,
				paddedBreaches: solved.paddedBreaches,
				zooms: solved.zooms,
			});
		}
	}
	return {
		sequences: solvedSequences.filter(
			(sequence) => sequence.resolvedScale >= policy.minimumUsefulScale,
		),
		consumedSpans,
	};
}

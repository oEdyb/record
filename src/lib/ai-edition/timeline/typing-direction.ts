import type { KeyboardActivitySample } from "@/native/contracts";
import type { ConnectedClickSample } from "./connected-click-chain";

/** Tunable qualification and sampling for privacy-safe keyboard direction. */
export interface TypingDirectionPolicy {
	minimumKeyDownCount: number;
	minimumBurstDurationMs: number;
	typingIdleGapMs: number;
	maximumTargetCenterDistance: number;
	clickFallbackMaximumAgeMs: number;
	clickFallbackTargetPaddingRatio: number;
	maximumFallbackTargetWidthRatio: number;
	maximumFallbackTargetHeightRatio: number;
	anchorIntervalMs: number;
	anchorMovementDistance: number;
	maximumFramingWidthRatio: number;
	maximumFramingHeightRatio: number;
	framingPaddingRatio: number;
}

export const DEFAULT_TYPING_DIRECTION_POLICY: TypingDirectionPolicy = Object.freeze({
	minimumKeyDownCount: 3,
	minimumBurstDurationMs: 250,
	typingIdleGapMs: 1_250,
	maximumTargetCenterDistance: 0.3,
	clickFallbackMaximumAgeMs: 2_000,
	clickFallbackTargetPaddingRatio: 0.01,
	maximumFallbackTargetWidthRatio: 0.25,
	maximumFallbackTargetHeightRatio: 0.2,
	anchorIntervalMs: 250,
	anchorMovementDistance: 0.03,
	maximumFramingWidthRatio: 0.46,
	maximumFramingHeightRatio: 0.36,
	framingPaddingRatio: 0.03,
});

const distance = (left: { cx: number; cy: number }, right: { cx: number; cy: number }) =>
	Math.hypot(left.cx - right.cx, left.cy - right.cy);

function pointInsideTarget(
	point: { cx: number; cy: number },
	target: NonNullable<KeyboardActivitySample["targetRect"]>,
	padding: number,
) {
	return (
		point.cx >= target.x - padding &&
		point.cx <= target.x + target.width + padding &&
		point.cy >= target.y - padding &&
		point.cy <= target.y + target.height + padding
	);
}

function compactTargetFocus(
	sample: KeyboardActivitySample,
	policy: TypingDirectionPolicy,
): { cx: number; cy: number } | null {
	const target = sample.targetRect;
	if (
		!target ||
		target.width <= 0 ||
		target.height <= 0 ||
		target.width > policy.maximumFallbackTargetWidthRatio ||
		target.height > policy.maximumFallbackTargetHeightRatio
	) {
		return null;
	}
	return { cx: target.x + target.width / 2, cy: target.y + target.height / 2 };
}

function hasTrustworthyReportedFocus(
	sample: KeyboardActivitySample,
	policy: TypingDirectionPolicy,
) {
	if (sample.focusSource === "target") return false;
	if (!sample.targetRect) return true;
	return (
		sample.focusSource === "caret" &&
		pointInsideTarget(sample, sample.targetRect, policy.clickFallbackTargetPaddingRatio)
	);
}

function lastClickBefore(
	clicks: ConnectedClickSample[],
	sample: KeyboardActivitySample,
	policy: TypingDirectionPolicy,
) {
	let low = 0;
	let high = clicks.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (clicks[middle].timeMs <= sample.timeMs) low = middle + 1;
		else high = middle;
	}
	const click = clicks[low - 1];
	if (!click || sample.timeMs - click.timeMs > policy.clickFallbackMaximumAgeMs) return null;
	if (
		sample.directionContextId &&
		click.directionContextId &&
		sample.directionContextId !== click.directionContextId
	) {
		return null;
	}
	return sample.targetRect &&
		pointInsideTarget(click, sample.targetRect, policy.clickFallbackTargetPaddingRatio)
		? click
		: null;
}

function resolveBurstFocus(
	burst: KeyboardActivitySample[],
	clicks: ConnectedClickSample[],
	policy: TypingDirectionPolicy,
) {
	let retainedFocus: { cx: number; cy: number } | null = null;
	return burst.flatMap((sample) => {
		if (
			retainedFocus &&
			sample.targetRect &&
			!pointInsideTarget(retainedFocus, sample.targetRect, policy.clickFallbackTargetPaddingRatio)
		) {
			retainedFocus = null;
		}
		if (hasTrustworthyReportedFocus(sample, policy)) {
			retainedFocus = { cx: sample.cx, cy: sample.cy };
		} else {
			const click = lastClickBefore(clicks, sample, policy);
			if (click) {
				retainedFocus = { cx: click.cx, cy: click.cy };
			} else if (!retainedFocus) {
				retainedFocus = compactTargetFocus(sample, policy);
			}
		}
		return retainedFocus ? [{ ...sample, ...retainedFocus }] : [];
	});
}

function sameTarget(
	left: KeyboardActivitySample,
	right: KeyboardActivitySample,
	policy: TypingDirectionPolicy,
) {
	if (
		left.directionContextId &&
		right.directionContextId &&
		left.directionContextId !== right.directionContextId
	) {
		return false;
	}
	if (
		left.directionTargetId &&
		right.directionTargetId &&
		left.directionTargetId !== right.directionTargetId
	) {
		return false;
	}
	if (left.targetRect && right.targetRect) {
		const overlapX =
			left.targetRect.x < right.targetRect.x + right.targetRect.width &&
			right.targetRect.x < left.targetRect.x + left.targetRect.width;
		const overlapY =
			left.targetRect.y < right.targetRect.y + right.targetRect.height &&
			right.targetRect.y < left.targetRect.y + left.targetRect.height;
		return overlapX && overlapY;
	}
	return distance(left, right) <= policy.maximumTargetCenterDistance;
}

function normalize(samples: KeyboardActivitySample[], durationMs: number) {
	return samples
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy) &&
				Number.isFinite(sample.count) &&
				sample.count > 0 &&
				sample.timeMs >= 0 &&
				sample.timeMs <= durationMs,
		)
		.map((sample) => ({
			...sample,
			cx: Math.min(1, Math.max(0, sample.cx)),
			cy: Math.min(1, Math.max(0, sample.cy)),
			count: Math.max(1, Math.round(sample.count)),
		}))
		.sort((left, right) => left.timeMs - right.timeMs);
}

function focusRect(sample: KeyboardActivitySample, policy: TypingDirectionPolicy) {
	const target = sample.targetRect;
	const padding = Math.max(0, policy.framingPaddingRatio);
	const left = Math.max(0, (target?.x ?? sample.cx) - padding);
	const top = Math.max(0, (target?.y ?? sample.cy) - padding);
	const right = Math.min(1, (target ? target.x + target.width : sample.cx) + padding);
	const bottom = Math.min(1, (target ? target.y + target.height : sample.cy) + padding);
	const width = Math.min(
		Math.max(0.02, right - left),
		Math.max(0.02, policy.maximumFramingWidthRatio),
	);
	const height = Math.min(
		Math.max(0.02, bottom - top),
		Math.max(0.02, policy.maximumFramingHeightRatio),
	);
	const x = Math.min(Math.max(left, sample.cx - width / 2), Math.max(left, right - width));
	const y = Math.min(Math.max(top, sample.cy - height / 2), Math.max(top, bottom - height));
	return { x, y, width, height };
}

/**
 * Turn sustained keyboard activity into click-style focus anchors. The raw
 * cursor path stays separate, so these synthetic anchors cannot move the saved
 * cursor. One qualified burst contributes one score unit, regardless of length.
 */
export function buildTypingFocusAnchors(options: {
	keyboardActivity: KeyboardActivitySample[];
	cursorTelemetry?: ConnectedClickSample[];
	durationMs: number;
	policy?: TypingDirectionPolicy;
}): ConnectedClickSample[] {
	const policy = options.policy ?? DEFAULT_TYPING_DIRECTION_POLICY;
	const samples = normalize(options.keyboardActivity, options.durationMs);
	const clicks = (options.cursorTelemetry ?? [])
		.filter(
			(sample) =>
				sample.interactionType === "click" &&
				sample.visible !== false &&
				!sample.directionExcluded &&
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy),
		)
		.sort((left, right) => left.timeMs - right.timeMs);
	const activities: KeyboardActivitySample[][] = [];
	let activity: KeyboardActivitySample[] | null = null;
	for (const sample of samples) {
		if (sample.directionExcluded) {
			activity = null;
			continue;
		}
		if (!activity) {
			activity = [sample];
			activities.push(activity);
			continue;
		}
		const previous = activity.at(-1)!;
		if (
			sample.timeMs - previous.timeMs <= policy.typingIdleGapMs &&
			sameTarget(previous, sample, policy)
		) {
			activity.push(sample);
		} else {
			activity = [sample];
			activities.push(activity);
		}
	}

	return activities.flatMap((activity) => {
		const first = activity[0];
		const last = activity.at(-1)!;
		const count = activity.reduce((total, sample) => total + sample.count, 0);
		if (
			count < policy.minimumKeyDownCount ||
			last.timeMs - first.timeMs < policy.minimumBurstDurationMs
		) {
			return [];
		}

		const resolved = resolveBurstFocus(activity, clicks, policy);
		if (resolved.length === 0) return [];
		const resolvedFirst = resolved[0];
		const resolvedLast = resolved.at(-1)!;
		const anchors = [resolvedFirst];
		for (const sample of resolved.slice(1, -1)) {
			const previous = anchors.at(-1)!;
			if (
				sample.timeMs - previous.timeMs >= policy.anchorIntervalMs ||
				distance(previous, sample) >= policy.anchorMovementDistance
			) {
				anchors.push(sample);
			}
		}
		if (resolvedLast !== resolvedFirst && anchors.at(-1) !== resolvedLast) {
			anchors.push(resolvedLast);
		}

		return anchors.map((sample, index) => {
			const framingRect = focusRect(sample, policy);
			return {
				timeMs: sample.timeMs,
				cx: framingRect.x + framingRect.width / 2,
				cy: framingRect.y + framingRect.height / 2,
				visible: true,
				interactionType: "typing",
				directionActivityId: `typing-${Math.round(first.timeMs)}`,
				directionWeight: index === 0 ? 1 : 0,
				framingRect,
			};
		});
	});
}

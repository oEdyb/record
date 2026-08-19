const CLICK_TYPES = new Set(["click", "double-click", "right-click", "middle-click"]);

export const DEFAULT_LAB_POLICY = Object.freeze({
	chainGapMs: 1_800,
	chainMaximumDurationMs: 6_000,
	clickDedupeMs: 120,
	clickDedupeDistance: 0.025,
	targetMergeMs: 1_600,
	targetMergeDistance: 0.08,
	requestedScale: 1.65,
	stablePadding: 0.065,
	safeInset: 0.18,
	deadZoneWidthRatio: 0.5,
	deadZoneHeightRatio: 0.7,
	anticipationMs: 100,
	minimumPanMs: 400,
	maximumPanMs: 700,
	panDistanceForMaximum: 0.5,
	entryMs: 650,
	exitMs: 900,
	holdAfterLastClickMs: 900,
	framesPerSecond: 60,
});

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const distance = (left, right) => Math.hypot(left.cx - right.cx, left.cy - right.cy);
const smootherstep = (value) => {
	const t = clamp(value, 0, 1);
	return t * t * t * (t * (t * 6 - 15) + 10);
};
const lerp = (start, end, amount) => start + (end - start) * amount;

function resolvedPolicy(overrides = {}) {
	return { ...DEFAULT_LAB_POLICY, ...overrides };
}

export function normalizeCursorPayload(payload) {
	const rawSamples = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.samples)
			? payload.samples
			: [];
	return rawSamples
		.filter(
			(sample) =>
				sample &&
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy) &&
				sample.timeMs >= 0,
		)
		.map((sample) => ({
			timeMs: sample.timeMs,
			cx: clamp(sample.cx, 0, 1),
			cy: clamp(sample.cy, 0, 1),
			visible: sample.visible !== false,
			interactionType: typeof sample.interactionType === "string" ? sample.interactionType : "move",
			directionExcluded: sample.directionExcluded === true,
		}))
		.sort((left, right) => left.timeMs - right.timeMs);
}

export function collapseClickSamples(samples, overrides = {}) {
	const policy = resolvedPolicy(overrides);
	const clicks = samples.filter(
		(sample) =>
			sample.visible !== false &&
			!sample.directionExcluded &&
			CLICK_TYPES.has(sample.interactionType),
	);
	const collapsed = [];
	for (const click of clicks) {
		const previous = collapsed.at(-1);
		if (
			previous &&
			click.timeMs - previous.timeMs <= policy.clickDedupeMs &&
			distance(click, previous) <= policy.clickDedupeDistance
		) {
			continue;
		}
		collapsed.push(click);
	}
	return collapsed;
}

export function findClickChains(samples, overrides = {}) {
	const policy = resolvedPolicy(overrides);
	const clicks = collapseClickSamples(samples, policy);
	if (clicks.length === 0) return [];

	const chains = [];
	let current = [clicks[0]];
	for (const click of clicks.slice(1)) {
		const gap = click.timeMs - current.at(-1).timeMs;
		const duration = click.timeMs - current[0].timeMs;
		if (gap <= policy.chainGapMs && duration <= policy.chainMaximumDurationMs) {
			current.push(click);
			continue;
		}
		chains.push(current);
		current = [click];
	}
	chains.push(current);

	return chains.map((chain, index) => ({
		id: `chain-${index + 1}`,
		clicks: chain,
		startMs: chain[0].timeMs,
		endMs: chain.at(-1).timeMs,
		durationMs: chain.at(-1).timeMs - chain[0].timeMs,
	}));
}

export function selectDefaultChain(chains) {
	return (
		[...chains].sort((left, right) => {
			if (right.clicks.length !== left.clicks.length)
				return right.clicks.length - left.clicks.length;
			return right.durationMs - left.durationMs;
		})[0] ?? null
	);
}

function lowerBound(samples, timeMs) {
	let low = 0;
	let high = samples.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (samples[middle].timeMs < timeMs) low = middle + 1;
		else high = middle;
	}
	return low;
}

export function interpolateCursor(samples, timeMs) {
	if (samples.length === 0) return { cx: 0.5, cy: 0.5, directionExcluded: false };
	const nextIndex = lowerBound(samples, timeMs);
	if (nextIndex <= 0) return samples[0];
	if (nextIndex >= samples.length) return samples.at(-1);
	const previous = samples[nextIndex - 1];
	const next = samples[nextIndex];
	if (next.timeMs === timeMs) return next;
	const progress = (timeMs - previous.timeMs) / Math.max(1, next.timeMs - previous.timeMs);
	return {
		cx: lerp(previous.cx, next.cx, progress),
		cy: lerp(previous.cy, next.cy, progress),
		visible: previous.visible !== false,
		directionExcluded: previous.directionExcluded || next.directionExcluded,
	};
}

function clampFocus(focus, scale) {
	const half = 0.5 / Math.max(1, scale);
	return {
		cx: clamp(focus.cx, half, 1 - half),
		cy: clamp(focus.cy, half, 1 - half),
	};
}

function scaleAtTime(timeMs, activeStartMs, activeEndMs, scale, policy) {
	if (timeMs < activeStartMs || timeMs > activeEndMs + policy.exitMs) return 1;
	if (timeMs < activeStartMs + policy.entryMs) {
		return lerp(1, scale, smootherstep((timeMs - activeStartMs) / policy.entryMs));
	}
	if (timeMs <= activeEndMs) return scale;
	return lerp(scale, 1, smootherstep((timeMs - activeEndMs) / policy.exitMs));
}

function frameIsSafe(cursor, focus, scale, safeInset) {
	const visibleHalf = 0.5 / Math.max(1, scale);
	const paddedHalf = visibleHalf * (1 - safeInset);
	return {
		visible:
			Math.abs(cursor.cx - focus.cx) <= visibleHalf + 1e-6 &&
			Math.abs(cursor.cy - focus.cy) <= visibleHalf + 1e-6,
		padded:
			Math.abs(cursor.cx - focus.cx) <= paddedHalf + 1e-6 &&
			Math.abs(cursor.cy - focus.cy) <= paddedHalf + 1e-6,
	};
}

function makeFrameTimes(window, policy) {
	const stepMs = 1_000 / policy.framesPerSecond;
	const times = [];
	for (let timeMs = window.startMs; timeMs <= window.endMs + 0.01; timeMs += stepMs) {
		times.push(timeMs);
	}
	return times;
}

function fitStableFocus(points, requestedScale, policy) {
	const minimumX = Math.min(...points.map((point) => point.cx));
	const maximumX = Math.max(...points.map((point) => point.cx));
	const minimumY = Math.min(...points.map((point) => point.cy));
	const maximumY = Math.max(...points.map((point) => point.cy));
	const paddedWidth = maximumX - minimumX + policy.stablePadding * 2;
	const paddedHeight = maximumY - minimumY + policy.stablePadding * 2;
	const safeScale = Math.min(1 / Math.max(paddedWidth, 1e-6), 1 / Math.max(paddedHeight, 1e-6));
	const scale = clamp(Math.min(requestedScale, safeScale), 1, requestedScale);
	return {
		focus: clampFocus({ cx: (minimumX + maximumX) / 2, cy: (minimumY + maximumY) / 2 }, scale),
		scale,
	};
}

function mergeTargets(clicks, policy) {
	const targets = [];
	for (const click of clicks) {
		const previous = targets.at(-1);
		if (
			previous &&
			click.timeMs - previous.timeMs <= policy.targetMergeMs &&
			distance(click, previous) <= policy.targetMergeDistance
		) {
			previous.cx = (previous.cx * previous.count + click.cx) / (previous.count + 1);
			previous.cy = (previous.cy * previous.count + click.cy) / (previous.count + 1);
			previous.timeMs = click.timeMs;
			previous.count += 1;
			continue;
		}
		targets.push({ ...click, count: 1 });
	}
	return targets;
}

function panDuration(left, right, policy) {
	const progress = clamp(distance(left, right) / policy.panDistanceForMaximum, 0, 1);
	return lerp(policy.minimumPanMs, policy.maximumPanMs, progress);
}

function moveFocusByMinimumDistance(previousFocus, target, scale, policy) {
	const halfWidth = policy.deadZoneWidthRatio / (2 * scale);
	const halfHeight = policy.deadZoneHeightRatio / (2 * scale);
	const next = { ...previousFocus };
	if (target.cx < previousFocus.cx - halfWidth) next.cx = target.cx + halfWidth;
	else if (target.cx > previousFocus.cx + halfWidth) next.cx = target.cx - halfWidth;
	if (target.cy < previousFocus.cy - halfHeight) next.cy = target.cy + halfHeight;
	else if (target.cy > previousFocus.cy + halfHeight) next.cy = target.cy - halfHeight;
	return clampFocus(next, scale);
}

function makeFocusTargets(clickTargets, scale, policy) {
	let focus = clampFocus({ cx: 0.5, cy: 0.5 }, scale);
	const targets = [];
	for (const click of clickTargets) {
		const nextFocus = moveFocusByMinimumDistance(focus, click, scale, policy);
		if (targets.length === 0 || distance(focus, nextFocus) > 0.002) {
			targets.push({ ...nextFocus, timeMs: click.timeMs, count: click.count });
		}
		focus = nextFocus;
	}
	return targets.length > 0
		? targets
		: [{ ...focus, timeMs: clickTargets[0].timeMs, count: clickTargets.length }];
}

function makeTransitions(focusTargets, policy) {
	let previousEndMs = Number.NEGATIVE_INFINITY;
	return focusTargets.slice(1).map((target, index) => {
		const previous = focusTargets[index];
		const durationMs = panDuration(previous, target, policy);
		const desiredEndMs = target.timeMs - policy.anticipationMs;
		const startMs = Math.max(desiredEndMs - durationMs, previousEndMs);
		const endMs = startMs + durationMs;
		previousEndMs = endMs;
		return {
			previous,
			target,
			startMs,
			endMs,
			durationMs,
			delayMs: Math.max(0, endMs - desiredEndMs),
		};
	});
}

function focusFromTransitions(timeMs, targets, transitions) {
	let focus = targets[0];
	for (const transition of transitions) {
		if (timeMs < transition.startMs) break;
		if (timeMs <= transition.endMs) {
			const progress = smootherstep(
				(timeMs - transition.startMs) / Math.max(1, transition.durationMs),
			);
			return {
				cx: lerp(transition.previous.cx, transition.target.cx, progress),
				cy: lerp(transition.previous.cy, transition.target.cy, progress),
			};
		}
		focus = transition.target;
	}
	return focus;
}

function buildConnectedFrames(
	samples,
	window,
	activeStartMs,
	activeEndMs,
	clickTargets,
	scale,
	policy,
) {
	const focusTargets = makeFocusTargets(clickTargets, scale, policy);
	const transitions = makeTransitions(focusTargets, policy);
	const frames = makeFrameTimes(window, policy).map((timeMs) => {
		const cursor = interpolateCursor(samples, timeMs);
		const frameScale = scaleAtTime(timeMs, activeStartMs, activeEndMs, scale, policy);
		const intendedFocus = focusFromTransitions(timeMs, focusTargets, transitions);
		const frameFocus = clampFocus(intendedFocus, frameScale);
		const safety =
			cursor.visible === false || cursor.directionExcluded
				? { visible: true, padded: true }
				: frameIsSafe(cursor, frameFocus, frameScale, policy.safeInset);
		return {
			timeMs,
			cx: frameFocus.cx,
			cy: frameFocus.cy,
			scale: frameScale,
			cursorX: cursor.cx,
			cursorY: cursor.cy,
			cursorVisible: cursor.visible !== false,
			visibleSafe: safety.visible,
			paddedSafe: safety.padded,
		};
	});
	return { frames, focusTargets, transitions };
}

function framesAreSafe(frames, field, activeStartMs, activeEndMs) {
	return frames.every(
		(frame) => frame.timeMs < activeStartMs || frame.timeMs > activeEndMs || frame[field],
	);
}

function summarizeFrames(frames) {
	let croppedFrames = 0;
	let paddedBreaches = 0;
	let travel = 0;
	for (let index = 0; index < frames.length; index += 1) {
		const frame = frames[index];
		if (!frame.visibleSafe) croppedFrames += 1;
		if (!frame.paddedSafe) paddedBreaches += 1;
		if (index > 0) travel += distance(frame, frames[index - 1]);
	}
	return {
		croppedFrames,
		paddedBreaches,
		travel: Math.round(travel * 1_000) / 1_000,
	};
}

function buildFixedVariant({
	id,
	label,
	description,
	samples,
	window,
	activeStartMs,
	activeEndMs,
	focus,
	scale,
	policy,
	targetCount,
}) {
	const frames = makeFrameTimes(window, policy).map((timeMs) => {
		const cursor = interpolateCursor(samples, timeMs);
		const frameScale = scaleAtTime(timeMs, activeStartMs, activeEndMs, scale, policy);
		const frameFocus = clampFocus(focus, frameScale);
		const safety =
			cursor.visible === false || cursor.directionExcluded
				? { visible: true, padded: true }
				: frameIsSafe(cursor, frameFocus, frameScale, policy.safeInset);
		return {
			timeMs,
			cx: frameFocus.cx,
			cy: frameFocus.cy,
			scale: frameScale,
			cursorX: cursor.cx,
			cursorY: cursor.cy,
			cursorVisible: cursor.visible !== false,
			visibleSafe: safety.visible,
			paddedSafe: safety.padded,
		};
	});
	return {
		id,
		label,
		description,
		frames,
		resolvedScale: scale,
		targetCount,
		...summarizeFrames(frames),
	};
}

function buildConnectedVariant(samples, chain, window, policy) {
	const clickTargets = mergeTargets(chain.clicks, policy);
	const activeStartMs = chain.startMs - policy.entryMs;
	const activeEndMs = chain.endMs + policy.holdAfterLastClickMs;
	const safetyEndMs = activeEndMs + policy.exitMs;
	let resolvedScale = policy.requestedScale;
	let result = buildConnectedFrames(
		samples,
		window,
		activeStartMs,
		activeEndMs,
		clickTargets,
		resolvedScale,
		policy,
	);

	if (!framesAreSafe(result.frames, "paddedSafe", activeStartMs, safetyEndMs)) {
		const fullFrame = buildConnectedFrames(
			samples,
			window,
			activeStartMs,
			activeEndMs,
			clickTargets,
			1,
			policy,
		);
		if (!framesAreSafe(fullFrame.frames, "paddedSafe", activeStartMs, safetyEndMs)) {
			if (!framesAreSafe(result.frames, "visibleSafe", activeStartMs, safetyEndMs)) {
				let safeScale = 1;
				let unsafeScale = policy.requestedScale;
				result = fullFrame;
				for (let iteration = 0; iteration < 12; iteration += 1) {
					const candidateScale = (safeScale + unsafeScale) / 2;
					const candidate = buildConnectedFrames(
						samples,
						window,
						activeStartMs,
						activeEndMs,
						clickTargets,
						candidateScale,
						policy,
					);
					if (framesAreSafe(candidate.frames, "visibleSafe", activeStartMs, safetyEndMs)) {
						safeScale = candidateScale;
						result = candidate;
					} else {
						unsafeScale = candidateScale;
					}
				}
				resolvedScale = safeScale;
			}
		} else {
			let safeScale = 1;
			let unsafeScale = policy.requestedScale;
			result = fullFrame;
			for (let iteration = 0; iteration < 12; iteration += 1) {
				const candidateScale = (safeScale + unsafeScale) / 2;
				const candidate = buildConnectedFrames(
					samples,
					window,
					activeStartMs,
					activeEndMs,
					clickTargets,
					candidateScale,
					policy,
				);
				if (framesAreSafe(candidate.frames, "paddedSafe", activeStartMs, safetyEndMs)) {
					safeScale = candidateScale;
					result = candidate;
				} else {
					unsafeScale = candidateScale;
				}
			}
			resolvedScale = safeScale;
		}
	}

	const { frames, focusTargets, transitions } = result;

	return {
		id: "connected",
		label: "Dead-zone chain",
		description:
			"Stay zoomed. Pan between settled targets and lower the scale when the recorded path needs more room.",
		frames,
		resolvedScale,
		targetCount: focusTargets.length,
		transitions,
		...summarizeFrames(frames),
	};
}

export function buildLabComparison(samples, chain, overrides = {}) {
	if (!chain || chain.clicks.length === 0) throw new Error("A click chain is required");
	const policy = resolvedPolicy(overrides);
	const requestedWindowEnd = chain.endMs + policy.holdAfterLastClickMs + policy.exitMs + 700;
	const mediaEndMs =
		Number.isFinite(policy.durationMs) && policy.durationMs >= 0
			? policy.durationMs
			: Number.POSITIVE_INFINITY;
	const window = {
		startMs: Math.min(mediaEndMs, Math.max(0, chain.startMs - 1_800)),
		endMs: Math.min(mediaEndMs, requestedWindowEnd),
	};
	const lastClick = chain.clicks.at(-1);
	const baselineScale = Math.min(policy.requestedScale, 1.65);
	const baselineFocus = clampFocus(lastClick, baselineScale);
	const stablePoints = samples.filter(
		(sample) =>
			sample.visible !== false &&
			!sample.directionExcluded &&
			sample.timeMs >= chain.startMs - 100 &&
			sample.timeMs <= chain.endMs + policy.holdAfterLastClickMs,
	);
	const stable = fitStableFocus(
		stablePoints.length > 0 ? stablePoints : chain.clicks,
		policy.requestedScale,
		policy,
	);

	return {
		policy,
		window,
		clicks: chain.clicks,
		variants: [
			buildFixedVariant({
				id: "last-target",
				label: "Last-target baseline",
				description:
					"Representative of the winner-take-all result: earlier clicks stay full frame and the final target wins.",
				samples,
				window,
				activeStartMs: lastClick.timeMs - 350,
				activeEndMs: lastClick.timeMs + 1_600,
				focus: baselineFocus,
				scale: baselineScale,
				policy,
				targetCount: 1,
			}),
			buildFixedVariant({
				id: "stable",
				label: "Stable crop",
				description:
					"Fit one crop around the click group. This removes camera motion but can make the zoom shallower.",
				samples,
				window,
				activeStartMs: chain.startMs - policy.entryMs,
				activeEndMs: chain.endMs + policy.holdAfterLastClickMs,
				focus: stable.focus,
				scale: stable.scale,
				policy,
				targetCount: 1,
			}),
			buildConnectedVariant(samples, chain, window, policy),
		],
	};
}

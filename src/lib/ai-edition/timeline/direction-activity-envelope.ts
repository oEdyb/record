export interface DirectionActivityPoint {
	cx: number;
	cy: number;
}

export interface DirectionActivityEnvelopePolicy {
	outlierTrimRatio: number;
	padding: number;
	minimumScale: number;
	maximumScale: number;
	scaleSteps: ReadonlyArray<{ maximumSpan: number; scale: number }>;
	fallbackScale: number;
}

export interface FittedDirectionActivityEnvelope {
	focus: { cx: number; cy: number };
	scale: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function trimmedRange(
	points: DirectionActivityPoint[],
	anchors: DirectionActivityPoint[],
	axis: "cx" | "cy",
	trimRatio: number,
) {
	const values = points.map((point) => point[axis]).sort((a, b) => a - b);
	const trim = Math.min(
		Math.floor(values.length * clamp(trimRatio, 0, 0.25)),
		Math.floor((values.length - 1) / 2),
	);
	let minimum = values[trim];
	let maximum = values[values.length - 1 - trim];
	for (const anchor of anchors) {
		minimum = Math.min(minimum, anchor[axis]);
		maximum = Math.max(maximum, anchor[axis]);
	}
	return { minimum, maximum };
}

function desiredScaleForSpan(span: number, policy: DirectionActivityEnvelopePolicy) {
	return policy.scaleSteps.find((step) => span <= step.maximumSpan)?.scale ?? policy.fallbackScale;
}

function fitAxis(minimum: number, maximum: number, padding: number, halfViewport: number) {
	const paddedMinimum = clamp(minimum - padding, 0, 1);
	const paddedMaximum = clamp(maximum + padding, 0, 1);
	const lowerFocus = Math.max(halfViewport, paddedMaximum - halfViewport);
	const upperFocus = Math.min(1 - halfViewport, paddedMinimum + halfViewport);
	return clamp((minimum + maximum) / 2, lowerFocus, Math.max(lowerFocus, upperFocus));
}

/**
 * Fit one stable crop around the interaction area. Repeated samples represent
 * attention, so trimming a small fraction removes quick fly-bys while click
 * anchors always remain inside the crop.
 */
export function fitDirectionActivityEnvelope(options: {
	points: DirectionActivityPoint[];
	anchors: DirectionActivityPoint[];
	policy: DirectionActivityEnvelopePolicy;
}): FittedDirectionActivityEnvelope | null {
	if (options.points.length === 0 || options.anchors.length === 0) return null;

	const x = trimmedRange(options.points, options.anchors, "cx", options.policy.outlierTrimRatio);
	const y = trimmedRange(options.points, options.anchors, "cy", options.policy.outlierTrimRatio);
	const padding = clamp(options.policy.padding, 0, 0.2);
	const paddedWidth = clamp(x.maximum + padding, 0, 1) - clamp(x.minimum - padding, 0, 1);
	const paddedHeight = clamp(y.maximum + padding, 0, 1) - clamp(y.minimum - padding, 0, 1);
	const maximumSafeScale = Math.min(
		paddedWidth > 0 ? 1 / paddedWidth : Number.POSITIVE_INFINITY,
		paddedHeight > 0 ? 1 / paddedHeight : Number.POSITIVE_INFINITY,
		options.policy.maximumScale,
	);
	const desiredScale = desiredScaleForSpan(
		Math.max(x.maximum - x.minimum, y.maximum - y.minimum),
		options.policy,
	);
	const scale = Math.min(desiredScale, maximumSafeScale);
	if (!Number.isFinite(scale) || scale < options.policy.minimumScale) return null;

	const halfViewport = 0.5 / scale;
	return {
		focus: {
			cx: fitAxis(x.minimum, x.maximum, padding, halfViewport),
			cy: fitAxis(y.minimum, y.maximum, padding, halfViewport),
		},
		scale,
	};
}

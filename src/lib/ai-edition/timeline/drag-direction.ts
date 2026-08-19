import type { ConnectedClickSample } from "./connected-click-chain";
import type { ConnectedClickPolicy } from "./connected-click-policy";

const distance = (left: ConnectedClickSample, right: ConnectedClickSample) =>
	Math.hypot(left.cx - right.cx, left.cy - right.cy);

const clamp = (value: number, minimum: number, maximum: number) =>
	Math.min(maximum, Math.max(minimum, value));

/**
 * Convert raw press/path/release telemetry into one derived focus activity.
 *
 * The raw press remains the only ranking unit. The derived start only gives the
 * gesture a stable identity, and the zero-weight release supplies its final
 * destination. Ordinary clicks and tiny pointer jitter therefore keep their
 * existing behavior.
 */
export function buildDragFocusActivities(
	cursor: ConnectedClickSample[],
	policy: ConnectedClickPolicy,
): ConnectedClickSample[] {
	const ordered = [...cursor].sort((left, right) => left.timeMs - right.timeMs);
	const activities: ConnectedClickSample[] = [];
	let pressIndex: number | null = null;

	for (let index = 0; index < ordered.length; index += 1) {
		const sample = ordered[index];
		if (sample.visible === false || sample.directionExcluded) {
			pressIndex = null;
			continue;
		}
		if (sample.interactionType === "click") {
			pressIndex = index;
			continue;
		}
		if (sample.interactionType !== "mouseup" || pressIndex === null) continue;

		const startIndex = pressIndex;
		const press = ordered[startIndex];
		pressIndex = null;
		const durationMs = sample.timeMs - press.timeMs;
		if (durationMs < policy.dragMinimumDurationMs || durationMs > policy.dragMaximumDurationMs) {
			continue;
		}
		let pathDistance = 0;
		let previous = press;
		let minimumX = press.cx;
		let maximumX = press.cx;
		let minimumY = press.cy;
		let maximumY = press.cy;
		for (let pathIndex = startIndex + 1; pathIndex <= index; pathIndex += 1) {
			const point = ordered[pathIndex];
			if (point.visible === false || point.directionExcluded) {
				pathDistance = 0;
				break;
			}
			pathDistance += distance(previous, point);
			minimumX = Math.min(minimumX, point.cx);
			maximumX = Math.max(maximumX, point.cx);
			minimumY = Math.min(minimumY, point.cy);
			maximumY = Math.max(maximumY, point.cy);
			previous = point;
		}
		if (
			distance(press, sample) < policy.dragMinimumDistance &&
			pathDistance < policy.dragMinimumPath
		) {
			continue;
		}

		const activityId = `drag-${Math.round(press.timeMs)}-${Math.round(sample.timeMs)}`;
		const padding = clamp(policy.dragFramingPadding, 0, 0.2);
		const left = clamp(minimumX - padding, 0, 1);
		const top = clamp(minimumY - padding, 0, 1);
		const framingRect = {
			x: left,
			y: top,
			width: clamp(maximumX + padding, 0, 1) - left,
			height: clamp(maximumY + padding, 0, 1) - top,
		};
		activities.push(
			{
				...press,
				interactionType: "drag-start",
				directionActivityId: activityId,
				directionWeight: 0,
				framingRect,
				framingMode: "center",
			},
			{
				...sample,
				interactionType: "drag-end",
				directionActivityId: activityId,
				directionWeight: 0,
				framingRect,
				framingMode: "center",
			},
		);
	}

	return activities;
}

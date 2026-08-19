export interface MacMouseButtonTransition {
	kind: "down" | "up";
	timestampMs: number;
	x: number;
	y: number;
}

/** Keep ordered press/release transitions even when both arrive in one helper sample. */
export function normalizeMacMouseButtonTransitions(value: unknown): MacMouseButtonTransition[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(item): item is MacMouseButtonTransition =>
				typeof item === "object" &&
				item !== null &&
				"kind" in item &&
				(item.kind === "down" || item.kind === "up") &&
				"timestampMs" in item &&
				Number.isFinite(item.timestampMs) &&
				"x" in item &&
				Number.isFinite(item.x) &&
				"y" in item &&
				Number.isFinite(item.y),
		)
		.sort((left, right) => left.timestampMs - right.timestampMs);
}

export function resolveMacMouseInteraction(options: {
	leftButtonDown: boolean;
	leftButtonPressed: boolean;
	leftButtonReleased: boolean;
	previousLeftButtonDown: boolean;
	inferStateTransition: boolean;
}): "move" | "click" | "mouseup" {
	if (
		options.leftButtonPressed ||
		(options.inferStateTransition && options.leftButtonDown && !options.previousLeftButtonDown)
	) {
		return "click";
	}
	if (
		options.leftButtonReleased ||
		(options.inferStateTransition && !options.leftButtonDown && options.previousLeftButtonDown)
	) {
		return "mouseup";
	}
	return "move";
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** How far up from the window's bottom edge the pill stays reachable. */
const MIN_VISIBLE_FROM_BOTTOM = 80;

/**
 * Where a dragged HUD window may go. The pill sits at the window's bottom
 * centre, so that point stays on the display: a drag can reach every edge but
 * never carry the pill off screen.
 */
export function clampHudDragPosition(
	position: { x: number; y: number },
	size: { width: number; height: number },
	display: { bounds: Rect; workArea: Rect },
): { x: number; y: number } {
	const { bounds, workArea } = display;
	const centerX = Math.min(
		Math.max(position.x + size.width / 2, workArea.x),
		workArea.x + workArea.width,
	);
	const bottom = Math.min(
		Math.max(position.y + size.height, workArea.y + MIN_VISIBLE_FROM_BOTTOM),
		bounds.y + bounds.height,
	);
	return {
		x: Math.round(centerX - size.width / 2) | 0,
		y: Math.round(bottom - size.height) | 0,
	};
}

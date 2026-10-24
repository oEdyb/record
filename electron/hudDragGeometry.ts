interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Size {
	width: number;
	height: number;
}

/** The idle pill, until the renderer reports what it actually painted. */
export const DEFAULT_HUD_PILL_SIZE: Size = { width: 424, height: 50 };

/** Gap between the pill and the bottom of the work area when the HUD first opens. */
const HUD_HOME_BOTTOM_GAP = 25;

/**
 * The pill sits at the centre of its transparent window, which reserves room
 * for menus on both sides and may reach past the display. Only the pill has to
 * stay on screen, so the window centre is clamped until the whole pill fits in
 * the work area: it can touch every edge and never leave the display.
 */
function clampPillCenter(center: { x: number; y: number }, pill: Size, workArea: Rect) {
	const clampAxis = (value: number, start: number, length: number, extent: number) => {
		if (extent >= length) return start + length / 2;
		return Math.min(Math.max(value, start + extent / 2), start + length - extent / 2);
	};
	return {
		x: clampAxis(center.x, workArea.x, workArea.width, pill.width),
		y: clampAxis(center.y, workArea.y, workArea.height, pill.height),
	};
}

function windowAround(center: { x: number; y: number }, size: Size): Rect {
	// `| 0` turns Math.round's -0 into 0; Electron's native setters reject -0.
	return {
		x: Math.round(center.x - size.width / 2) | 0,
		y: Math.round(center.y - size.height / 2) | 0,
		width: size.width,
		height: size.height,
	};
}

/** Where a dragged HUD window may go, so the whole pill stays on the display. */
export function clampHudDragPosition(
	position: { x: number; y: number },
	size: Size,
	pill: Size,
	workArea: Rect,
): { x: number; y: number } {
	const center = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
	const { x, y } = windowAround(clampPillCenter(center, pill, workArea), size);
	return { x, y };
}

/** A resized HUD keeps its pill where it was, pulled back inside the work area if needed. */
export function resizeHudAroundPill(current: Rect, size: Size, pill: Size, workArea: Rect): Rect {
	const center = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
	return windowAround(clampPillCenter(center, pill, workArea), size);
}

/** The HUD opens with its pill centred near the bottom of the work area. */
export function initialHudBounds(size: Size, pill: Size, workArea: Rect): Rect {
	const center = {
		x: workArea.x + workArea.width / 2,
		y: workArea.y + workArea.height - HUD_HOME_BOTTOM_GAP - pill.height / 2,
	};
	return windowAround(clampPillCenter(center, pill, workArea), size);
}

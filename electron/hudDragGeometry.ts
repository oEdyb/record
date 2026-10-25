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

/**
 * The painted pill, and how far its centre sits right of (and below) the window's
 * centre. A tab tucked into the top edge sits above the centre.
 */
interface Pill extends Size {
	offsetX: number;
	offsetY?: number;
}

/** Where the pill's centre sits on screen for a window at `position`. */
export function pillCenterOf(position: { x: number; y: number }, size: Size, pill: Pill) {
	return {
		x: position.x + size.width / 2 + pill.offsetX,
		y: position.y + size.height / 2 + (pill.offsetY ?? 0),
	};
}

/** The idle pill, until the renderer reports what it actually painted. */
export const DEFAULT_HUD_PILL_SIZE: Pill = { width: 424, height: 50, offsetX: 0 };

/** Gap between the pill and the bottom of the work area when the HUD first opens. */
const HUD_HOME_BOTTOM_GAP = 25;

/**
 * The pill sits in its transparent window, which reserves room for menus on
 * both sides and may reach past the display. Only the pill has to stay on
 * screen, so the pill's centre is clamped until the whole pill fits in the work
 * area: it can touch every edge and never leave the display.
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

function windowAround(pillCenter: { x: number; y: number }, size: Size, pill: Pill): Rect {
	const center = { x: pillCenter.x - pill.offsetX, y: pillCenter.y - (pill.offsetY ?? 0) };
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
	pill: Pill,
	workArea: Rect,
): { x: number; y: number } {
	const center = pillCenterOf(position, size, pill);
	const { x, y } = windowAround(clampPillCenter(center, pill, workArea), size, pill);
	return { x, y };
}

/** A resized HUD keeps its pill where it was, pulled back inside the work area if needed. */
export function resizeHudAroundPill(current: Rect, size: Size, pill: Pill, workArea: Rect): Rect {
	const center = pillCenterOf(current, current, pill);
	return windowAround(clampPillCenter(center, pill, workArea), size, pill);
}

/** The HUD opens with its pill centred near the bottom of the work area. */
export function initialHudBounds(size: Size, pill: Pill, workArea: Rect): Rect {
	const center = {
		x: workArea.x + workArea.width / 2,
		y: workArea.y + workArea.height - HUD_HOME_BOTTOM_GAP - pill.height / 2,
	};
	return windowAround(clampPillCenter(center, pill, workArea), size, pill);
}

export type HudDockSide = "left" | "right" | "top";

/** How far past an edge a drag must shove the pill before it tucks into that edge. */
export const HUD_DOCK_PUSH = 24;
/** How far away from its edge a drag must pull a tucked pill before it comes untucked. */
export const HUD_UNDOCK_PULL = 48;

/** Whether a drag pulls a tucked pill far enough off its edge to untuck it. */
export function hudPulledOffEdge(
	pillCenter: { x: number; y: number },
	pill: Size,
	workArea: Rect,
	side: HudDockSide,
): boolean {
	if (side === "left") return pillCenter.x - pill.width / 2 - workArea.x >= HUD_UNDOCK_PULL;
	if (side === "right")
		return workArea.x + workArea.width - (pillCenter.x + pill.width / 2) >= HUD_UNDOCK_PULL;
	return pillCenter.y - pill.height / 2 - workArea.y >= HUD_UNDOCK_PULL;
}

/**
 * The edge a drag shoves the pill past, if any. The pill itself is clamped on screen,
 * so this reads where the pointer asked it to go. An edge another display continues
 * past is not one to tuck into: the drag crosses to that display instead.
 */
export function hudDockPush(
	position: { x: number; y: number },
	size: Size,
	pill: Pill,
	workArea: Rect,
	openSides: ReadonlySet<HudDockSide>,
): HudDockSide | null {
	const center = pillCenterOf(position, size, pill);
	if (openSides.has("left") && center.x - pill.width / 2 <= workArea.x - HUD_DOCK_PUSH)
		return "left";
	if (
		openSides.has("right") &&
		center.x + pill.width / 2 >= workArea.x + workArea.width + HUD_DOCK_PUSH
	)
		return "right";
	if (openSides.has("top") && center.y - pill.height / 2 <= workArea.y - HUD_DOCK_PUSH)
		return "top";
	return null;
}

/** The edges of a display that no other display continues past. */
export function openDisplaySides(display: Rect, others: readonly Rect[]): Set<HudDockSide> {
	const overlaps = (start: number, length: number, otherStart: number, otherLength: number) =>
		otherStart < start + length && otherStart + otherLength > start;
	const reachesX = (x: number) =>
		others.some(
			(other) =>
				x >= other.x &&
				x < other.x + other.width &&
				overlaps(display.y, display.height, other.y, other.height),
		);
	const reachesAbove = others.some(
		(other) =>
			display.y - 1 >= other.y &&
			display.y - 1 < other.y + other.height &&
			overlaps(display.x, display.width, other.x, other.width),
	);
	const sides = new Set<HudDockSide>();
	if (!reachesX(display.x - 1)) sides.add("left");
	if (!reachesX(display.x + display.width)) sides.add("right");
	if (!reachesAbove) sides.add("top");
	return sides;
}

/**
 * Where the HUD goes for a pill held flush against an edge: the asked-for place along
 * the edge, clamped on screen, and nothing past the edge.
 */
export function hudBoundsAtEdge(
	pillCenter: { x: number; y: number },
	size: Size,
	pill: Pill,
	workArea: Rect,
	side: HudDockSide,
): Rect {
	const center = { ...pillCenter };
	if (side === "left") center.x = workArea.x + pill.width / 2;
	else if (side === "right") center.x = workArea.x + workArea.width - pill.width / 2;
	else center.y = workArea.y + pill.height / 2;
	return windowAround(clampPillCenter(center, pill, workArea), size, pill);
}

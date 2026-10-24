/**
 * Geometry for the HUD overlay window.
 *
 * The HUD lives in a transparent, click-through BrowserWindow whose size the
 * renderer drives over IPC. The old approach *discovered* the size it needed by
 * measuring whatever happened to be on screen and growing to fit, which closed a
 * feedback loop: a native resize changes the viewport, viewport-sized elements
 * re-layout, the ResizeObserver fires again, and another resize goes out. Ten
 * animation frames per resize turned that into visible flicker, and the first
 * open of every popover was a jump because its space had never been seen before.
 *
 * So: reserve instead of discover. The bar is the only thing whose size can't be
 * predicted (localized labels, source names), so it alone is measured. Everything
 * that floats above it has a fixed width and a capped, internally-scrolling
 * height, and that space is reserved in the window from the very first frame.
 * Opening or closing a popover, or a device list changing length, then costs
 * exactly zero native resizes.
 *
 * The bar sits at the window's centre and the reserve is mirrored above and
 * below it, so the floating stack can open on whichever side of the pill has
 * room without moving the window. The window may reach past the display; only
 * the pill is kept on screen (electron/hudDragGeometry.ts).
 *
 * Nothing here may depend on `window.innerWidth/innerHeight`: that is the edge
 * the loop used to close on. Screen-derived values (`screen.availHeight`) are
 * fine — they don't change when the window does.
 */

/** Gap between the pill and the work-area edge it rests against. */
export const HUD_BAR_BOTTOM = 20;
/** Hard minimum breathing room on every edge, so drop shadows aren't clipped. */
export const HUD_EDGE_SLACK = 24;
/** Vertical gap between the bar and the popover stack floating above it. */
export const HUD_POPOVER_GAP = 8;
/** Gap between stacked floating elements (popover, notices). */
export const HUD_STACK_GAP = 10;
/** Width of the device / language popovers. */
const HUD_POPOVER_WIDTH = 220;
/** Width of the top notices (locale suggestion, software-encoder fallback). */
const HUD_NOTICE_WIDTH = 360;
/** Widest the paused replay's video gets; its frame adds a 6px inset per side. */
const HUD_PEEK_VIDEO_MAX_WIDTH = 640;
const HUD_PEEK_WIDTH = HUD_PEEK_VIDEO_MAX_WIDTH + 12;
/**
 * Widest thing that can ever float above the bar. Always reserved, so a popover,
 * a notice or the replay appearing never changes the window's width.
 */
export const HUD_STACK_WIDTH = Math.max(HUD_POPOVER_WIDTH, HUD_NOTICE_WIDTH, HUD_PEEK_WIDTH);
/** Cap on any popover's height; past this it scrolls internally. */
export const HUD_POPOVER_MAX_HEIGHT = 320;
/** Floor for the popover cap on very short screens. */
export const HUD_POPOVER_MIN_HEIGHT = 140;
/**
 * The device-settings panel is the tallest floating surface, so it is what the
 * window reserves room for — permanently, whether or not it happens to be open.
 * Sizing the reserve to what is currently open would mean the window grows on
 * open, and because the stack is bottom-anchored, growing upward shifts all the
 * content down in window coordinates; the renderer repaints that a frame behind
 * the native resize, which reads as position judder. Its width matches
 * HUD_STACK_WIDTH so it never affects the window's width either.
 */
export const HUD_MODAL_MAX_HEIGHT = 560;
const HUD_MODAL_MIN_HEIGHT = 200;
/**
 * Slack granted *beyond* what is strictly required, on each axis. This is pure
 * hysteresis: the bar can grow by this much (recording controls appearing, a
 * longer source name) before the window has to resize at all, which is what
 * keeps the common interactions completely free of native window churn.
 */
export const HUD_GROWTH_RESERVE = 120;
/** Floor for the window itself, in case the bar measures as ~nothing. */
const HUD_MIN_WINDOW_WIDTH = 220;

export interface HudSize {
	width: number;
	height: number;
}

export interface HudSizeInput {
	barWidth: number;
	barHeight: number;
	/** 0 when no notice is on screen. */
	noticeHeight: number;
	/** Room reserved on each side of the bar: the tallest surface that can float there. */
	stackMaxHeight: number;
}

export type HudStackPlacement = "above" | "below";

export interface HudPlacementInput {
	/** The pill's top and bottom edges, in screen coordinates. */
	pillTop: number;
	pillBottom: number;
	/** The work area's top and bottom edges, in screen coordinates. */
	areaTop: number;
	areaBottom: number;
	/** Height the open stack would like to have. */
	stackHeight: number;
}

/**
 * Which side of the pill the floating stack opens on, and how tall it may get
 * there. Above is the default; the stack moves below only when it would not fit
 * above and there is more room below, as with a pill dragged near the top.
 */
export function computeHudPlacement(input: HudPlacementInput): {
	placement: HudStackPlacement;
	room: number;
} {
	const roomAbove = Math.round(input.pillTop - input.areaTop - HUD_POPOVER_GAP - HUD_EDGE_SLACK);
	const roomBelow = Math.round(
		input.areaBottom - input.pillBottom - HUD_POPOVER_GAP - HUD_EDGE_SLACK,
	);
	if (roomAbove >= input.stackHeight || roomAbove >= roomBelow) {
		return { placement: "above", room: Math.max(0, roomAbove) };
	}
	return { placement: "below", room: Math.max(0, roomBelow) };
}

/** A floating surface's height cap, shrunk to the room on its side but never below `floor`. */
export function fitHudStackCap(cap: number, room: number, floor: number): number {
	return Math.round(Math.max(floor, Math.min(cap, room)));
}

/** Most room the floating stack can get: the pill resting at one edge of the work area. */
function stackRoom(barHeight: number, availableHeight: number): number {
	return availableHeight - HUD_BAR_BOTTOM - barHeight - HUD_POPOVER_GAP - HUD_EDGE_SLACK * 2;
}

/**
 * How tall a popover may be given the room left above the bar. The vertical tray
 * can be several hundred pixels tall, so on a short screen the popover has to
 * give way rather than push the window off the top of the display.
 */
export function computeHudPopoverMaxHeight(barHeight: number, availableHeight: number): number {
	const room = stackRoom(barHeight, availableHeight);
	return Math.round(Math.min(HUD_POPOVER_MAX_HEIGHT, Math.max(HUD_POPOVER_MIN_HEIGHT, room)));
}

/** Same, for the taller device-settings panel. */
export function computeHudModalMaxHeight(barHeight: number, availableHeight: number): number {
	const room = stackRoom(barHeight, availableHeight);
	return Math.round(Math.min(HUD_MODAL_MAX_HEIGHT, Math.max(HUD_MODAL_MIN_HEIGHT, room)));
}

/** Tallest the bar itself is allowed to get before it scrolls internally. */
export function computeHudBarMaxHeight(availableHeight: number): number {
	return Math.round(
		Math.max(
			HUD_POPOVER_MIN_HEIGHT,
			availableHeight -
				HUD_BAR_BOTTOM -
				HUD_POPOVER_GAP -
				HUD_POPOVER_MIN_HEIGHT -
				HUD_EDGE_SLACK * 2,
		),
	);
}

/**
 * `required` is the smallest window that shows everything without clipping;
 * `granted` is what we actually ask for. The gap between them is the hysteresis
 * that stops small content changes from resizing the window.
 */
export function computeHudWindowSize(input: HudSizeInput): {
	required: HudSize;
	granted: HudSize;
} {
	const stackWidth = Math.max(Math.ceil(input.barWidth), HUD_STACK_WIDTH);
	const requiredWidth = Math.max(HUD_MIN_WINDOW_WIDTH, stackWidth + HUD_EDGE_SLACK * 2);

	const noticeBlock = input.noticeHeight > 0 ? HUD_STACK_GAP + Math.ceil(input.noticeHeight) : 0;
	const sideReserve =
		HUD_POPOVER_GAP + Math.ceil(input.stackMaxHeight) + noticeBlock + HUD_EDGE_SLACK;
	// No work-area ceiling: the window is allowed past the display, and the bar
	// stays at its centre so the stack can open on either side.
	const requiredHeight = Math.ceil(input.barHeight) + sideReserve * 2;

	return {
		required: { width: requiredWidth, height: requiredHeight },
		granted: {
			width: requiredWidth + HUD_GROWTH_RESERVE * 2,
			height: requiredHeight + HUD_GROWTH_RESERVE,
		},
	};
}

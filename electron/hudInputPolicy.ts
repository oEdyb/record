/**
 * macOS forwards pointer movement through a click-through Electron window without
 * the Windows low-level mouse hook. Starting this way prevents the HUD's large
 * transparent backing surface from intercepting desktop clicks before React mounts.
 */
export function shouldStartHudClickThrough(platform: NodeJS.Platform): boolean {
	return platform === "darwin";
}

/**
 * A macOS recording panel must not activate Klippt when it first appears. The
 * user can still activate its controls with a deliberate click.
 */
export function shouldShowHudInactive(platform: NodeJS.Platform): boolean {
	return platform === "darwin";
}

interface Point {
	x: number;
	y: number;
}

interface Rect extends Point {
	width: number;
	height: number;
}

/**
 * Where the cursor sits inside the HUD's content, or null once it has left the window.
 * While the HUD takes the mouse, an inactive app may get no pointer events to say the
 * pointer left the pill, so the main process asks this on a timer instead.
 */
export function hudPointerProbe(cursor: Point, content: Rect): Point | null {
	const x = cursor.x - content.x;
	const y = cursor.y - content.y;
	if (x < 0 || y < 0 || x >= content.width || y >= content.height) return null;
	return { x, y };
}

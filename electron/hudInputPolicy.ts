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

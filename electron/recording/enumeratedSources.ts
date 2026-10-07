import type { DesktopCapturerSource } from "electron";

type SourceType = "screen" | "window";

/**
 * A read refreshes only the kinds it asked for. A screens-only probe (the HUD's Display
 * shortcut, the paused display prebuild) must not evict the window list, or the next window
 * pick pays a full re-enumeration before the picker can close.
 */
export function mergeEnumeratedSources(
	previous: ReadonlyMap<string, DesktopCapturerSource>,
	sources: readonly DesktopCapturerSource[],
	types: readonly SourceType[],
): Map<string, DesktopCapturerSource> {
	const next = new Map<string, DesktopCapturerSource>();
	for (const [id, source] of previous) {
		if (!types.some((type) => id.startsWith(`${type}:`))) next.set(id, source);
	}
	for (const source of sources) next.set(source.id, source);
	return next;
}

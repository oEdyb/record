import { createDevFakeCleanCutBridge, devFakeCleanCutMode } from "./devFakeBridge";
import type { CleanCutBridge } from "./types";

let devFake: CleanCutBridge | null = null;

/**
 * The clean cut service, or null when this build has none. Development builds can swap
 * in the recorded-session fake; production code never reaches that branch.
 */
export function getCleanCutBridge(): CleanCutBridge | null {
	if (import.meta.env.DEV) {
		const mode = devFakeCleanCutMode();
		if (mode) {
			devFake ??= createDevFakeCleanCutBridge(mode);
			return devFake;
		}
	}
	return globalThis.window?.electronAPI?.cleanCut ?? null;
}

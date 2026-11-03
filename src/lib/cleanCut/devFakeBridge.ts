import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { snapshotFromFixture } from "./fixture";
import { type CleanCutBridge, type CleanCutSnapshot, EMPTY_CLEAN_CUT_SNAPSHOT } from "./types";

/**
 * Dev builds only: set this localStorage key to "1", "slow" or "fail" to use the fake, or to
 * "no-claude" / "claude-failed" for a ready result whose Claude check did not run once it is
 * turned on. The check starts off, as in the app.
 */
export const DEV_FAKE_CLEAN_CUT_KEY = "klippt.dev.fakeCleanCut";

export function devFakeCleanCutMode(): string | null {
	try {
		return globalThis.localStorage?.getItem(DEV_FAKE_CLEAN_CUT_KEY) ?? null;
	} catch {
		return null;
	}
}

/**
 * Plays back the recorded OBS session as if the main process had analysed the open
 * project: a few progress snapshots, then the ready result on its first recording.
 */
export function createDevFakeCleanCutBridge(mode: string): CleanCutBridge {
	const listeners = new Set<(snapshot: CleanCutSnapshot) => void>();
	let run = 0;
	const emit = (snapshot: CleanCutSnapshot) => {
		for (const listener of listeners) listener(snapshot);
	};
	let claudeCheck = false;
	const steps = mode === "slow" ? 40 : 14;
	return {
		async start(projectId) {
			const id = ++run;
			const document = useProjectStore.getState().document;
			const assetId = document?.project.primaryAssetId ?? document?.assets[0]?.id ?? "asset";
			const working = (progress: number): CleanCutSnapshot => ({
				...EMPTY_CLEAN_CUT_SNAPSHOT,
				projectId,
				state: "working",
				progress,
			});
			emit(working(0));
			void (async () => {
				for (let step = 1; step <= steps; step += 1) {
					await new Promise((resolve) => setTimeout(resolve, 220));
					if (id !== run) return;
					if (mode === "fail" && step === Math.round(steps * 0.6)) {
						emit({
							...working(step / steps),
							state: "failed",
							error: "The transcript helper stopped before it finished.",
						});
						return;
					}
					emit(working(Math.min(0.97, step / steps)));
				}
				const fixture = await import("../../../tests/fixtures/clean-cut-obs-session.json");
				if (id !== run) return;
				const ready = snapshotFromFixture(fixture.default, assetId, projectId);
				const modelCheck = !claudeCheck
					? "off"
					: mode === "no-claude"
						? "unavailable"
						: mode === "claude-failed"
							? "failed"
							: "done";
				emit({ ...ready, modelCheck });
			})();
		},
		async getClaudeCheck() {
			return claudeCheck;
		},
		async setClaudeCheck(enabled) {
			claudeCheck = enabled;
		},
		async cancel() {
			run += 1;
			emit(EMPTY_CLEAN_CUT_SNAPSHOT);
		},
		onSnapshot(callback) {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
	};
}

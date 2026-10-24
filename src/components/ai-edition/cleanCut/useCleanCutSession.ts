import { useEffect, useMemo } from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { getCleanCutBridge } from "@/lib/cleanCut/bridge";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { EMPTY_CLEAN_CUT_SNAPSHOT } from "@/lib/cleanCut/types";
import { ipcErrorMessage } from "@/lib/ipcErrorMessage";

/**
 * Connects the toggle to the main-process service. Turning it on starts an analysis of the
 * open project; a new clip starts it again; turning it off or opening another project
 * cancels it. Nothing here waits on the service, so review never does either.
 */
export function useCleanCutSession(projectId: string | null, clips: readonly AxcutClip[]) {
	const bridge = useMemo(() => getCleanCutBridge(), []);
	const enabled = useCleanCutStore((s) => s.enabled);
	const storeProjectId = useCleanCutStore((s) => s.projectId);
	const attempt = useCleanCutStore((s) => s.attempt);
	const assetKey = [...new Set(clips.map((clip) => clip.assetId))].sort().join("|");

	useEffect(() => {
		if (!bridge) return;
		return bridge.onSnapshot((snapshot) => useCleanCutStore.getState().receive(snapshot));
	}, [bridge]);

	useEffect(() => {
		if (storeProjectId !== projectId) useCleanCutStore.getState().setEnabled(false, projectId);
	}, [projectId, storeProjectId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt (Try again) starts a fresh run.
	useEffect(() => {
		if (!bridge || !enabled || !projectId || !assetKey || storeProjectId !== projectId) return;
		const store = useCleanCutStore.getState();
		store.receive({ ...EMPTY_CLEAN_CUT_SNAPSHOT, projectId, state: "working" });
		const document = useProjectStore.getState().document;
		Promise.resolve()
			.then(() => bridge.start(projectId, store.strength, structuredClone(document)))
			.catch((error) => {
				useCleanCutStore.getState().receive({
					...EMPTY_CLEAN_CUT_SNAPSHOT,
					projectId,
					state: "failed",
					error: ipcErrorMessage(error),
				});
			});
		return () => {
			void bridge.cancel().catch(() => undefined);
		};
	}, [bridge, enabled, projectId, storeProjectId, assetKey, attempt]);

	return { available: bridge !== null };
}

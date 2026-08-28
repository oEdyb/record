import { useEffect, useMemo, useState } from "react";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { type CleanVoiceRuntimeSnapshot, cleanVoiceRoutes } from "@/lib/cleanVoiceRuntime";

const UNAVAILABLE: CleanVoiceRuntimeSnapshot = { available: false, assets: [] };

export function useCleanVoiceRuntime(document: AxcutDocument | null) {
	const projectId = document?.project.id ?? null;
	const assetKey = document?.assets.map((asset) => asset.id).join("\0") ?? "";
	const assetIds = useMemo(() => (assetKey ? assetKey.split("\0") : []), [assetKey]);
	const naturalAssetIds = useMemo(
		() =>
			new Set(
				document?.assets
					.filter((asset) => asset.cleanVoice?.mode === "natural")
					.map((asset) => asset.id) ?? [],
			),
		[document],
	);
	const [snapshot, setSnapshot] = useState<CleanVoiceRuntimeSnapshot>(UNAVAILABLE);

	useEffect(() => {
		let active = true;
		if (!projectId || assetIds.length === 0 || !window.electronAPI?.getCleanVoiceRuntime) {
			setSnapshot(UNAVAILABLE);
			return;
		}

		void window.electronAPI.getCleanVoiceRuntime(projectId, assetIds).then((next) => {
			if (active) setSnapshot(next);
		});
		const unsubscribe = window.electronAPI.onCleanVoiceStatus?.((status) => {
			if (!active || status.projectId !== projectId || !assetIds.includes(status.assetId)) return;
			setSnapshot((current) => ({
				available: true,
				assets: [...current.assets.filter((asset) => asset.assetId !== status.assetId), status],
			}));
		});
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, [assetIds, projectId]);

	return useMemo(() => {
		const routes = new Map(
			[...cleanVoiceRoutes(snapshot)].filter(([assetId]) => naturalAssetIds.has(assetId)),
		);
		return { snapshot, routes };
	}, [naturalAssetIds, snapshot]);
}

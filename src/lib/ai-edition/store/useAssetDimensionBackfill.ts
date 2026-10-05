import { useEffect, useRef } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { probeVideoDimensions } from "../timeline/duration";
import { useProjectStore } from "./projectStore";

/**
 * Backfills missing source dimensions for any USED asset whose `video` was never probed.
 *
 * A project saved with a duration but no dimensions (for example, one migrated from before
 * dimensions were probed with the duration) is never re-probed on open. `asset.video` is the
 * single source of truth for a clip's shape: output resolution, the ratio list and the export
 * badges read it, so an unpopulated one silently drops that clip from all of them.
 *
 * Probes once on load and persists through `saveDocument`, which does not touch undo or
 * dirty state. Each asset is attempted at most once per mount, even on failure, so an
 * unreadable file does not spin the effect on every document change.
 */
export function useAssetDimensionBackfill(): void {
	const document = useProjectStore((s) => s.document);
	const probedAssetIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!document) return;
		const usedAssetIds = new Set(document.timeline.clips.map((c) => c.assetId));
		const missing = document.assets.filter(
			(a) =>
				usedAssetIds.has(a.id) &&
				a.originalPath &&
				(!a.video || !a.video.width || !a.video.height) &&
				!probedAssetIdsRef.current.has(a.id),
		);
		if (missing.length === 0) return;
		let cancelled = false;
		void (async () => {
			const probed: Record<string, { width: number; height: number }> = {};
			for (const a of missing) {
				probedAssetIdsRef.current.add(a.id);
				const dims = await probeVideoDimensions(toFileUrl(a.originalPath));
				if (dims) probed[a.id] = dims;
			}
			if (cancelled || Object.keys(probed).length === 0) return;
			// Re-read fresh state so a concurrent edit made while probing isn't stomped.
			const current = useProjectStore.getState().document;
			if (!current) return;
			await useProjectStore.getState().saveDocument({
				...current,
				assets: current.assets.map((a) =>
					probed[a.id]
						? { ...a, video: { codec: "unknown", fps: 0, ...a.video, ...probed[a.id] } }
						: a,
				),
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [document]);
}

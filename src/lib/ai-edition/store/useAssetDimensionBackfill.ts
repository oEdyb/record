import { useEffect, useRef } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset } from "../schema";
import { probeVideoDimensions } from "../timeline/duration";
import { useProjectStore } from "./projectStore";

type Dimensions = { width: number; height: number };

/**
 * Backfills missing source dimensions for any USED asset whose `video` was never probed,
 * and for its camera file when `cameraTrack` has no size yet.
 *
 * A project saved with a duration but no dimensions (for example, one migrated from before
 * dimensions were probed with the duration) is never re-probed on open. `asset.video` is the
 * single source of truth for a clip's shape: output resolution, the ratio list and the export
 * badges read it, so an unpopulated one silently drops that clip from all of them. The camera
 * size is the shape of the picture-in-picture tile; without it the export would lay the
 * camera out for a placeholder aspect the preview does not use.
 *
 * Probes once on load and persists through `saveDocument`, which does not touch undo or
 * dirty state. Each file is attempted at most once per mount, even on failure, so an
 * unreadable file does not spin the effect on every document change.
 */
export function useAssetDimensionBackfill(): void {
	const document = useProjectStore((s) => s.document);
	const probedKeysRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!document) return;
		const usedAssetIds = new Set(document.timeline.clips.map((c) => c.assetId));
		const used = document.assets.filter((a) => usedAssetIds.has(a.id));
		const missingScreens = used.filter(
			(a) =>
				a.originalPath &&
				(!a.video || !a.video.width || !a.video.height) &&
				!probedKeysRef.current.has(a.id),
		);
		const missingCameras = used.filter(
			(a) =>
				a.cameraTrack?.sourcePath &&
				(!a.cameraTrack.width || !a.cameraTrack.height) &&
				!probedKeysRef.current.has(cameraKey(a)),
		);
		if (missingScreens.length === 0 && missingCameras.length === 0) return;
		let cancelled = false;
		void (async () => {
			const screens: Record<string, Dimensions> = {};
			const cameras: Record<string, Dimensions> = {};
			for (const a of missingScreens) {
				probedKeysRef.current.add(a.id);
				const dims = await probeVideoDimensions(toFileUrl(a.originalPath));
				if (dims) screens[a.id] = dims;
			}
			for (const a of missingCameras) {
				const path = a.cameraTrack?.sourcePath;
				if (!path) continue;
				probedKeysRef.current.add(cameraKey(a));
				const dims = await probeVideoDimensions(toFileUrl(path));
				if (dims) cameras[cameraKey(a)] = dims;
			}
			if (cancelled || (Object.keys(screens).length === 0 && Object.keys(cameras).length === 0))
				return;
			// Re-read fresh state so a concurrent edit made while probing isn't stomped.
			const current = useProjectStore.getState().document;
			if (!current) return;
			await useProjectStore.getState().saveDocument({
				...current,
				assets: current.assets.map((a) => {
					const screen = screens[a.id];
					// Keyed by path, so a camera relinked while probing keeps no stale size.
					const camera = a.cameraTrack ? cameras[cameraKey(a)] : undefined;
					return screen || camera
						? {
								...a,
								...(screen ? { video: { codec: "unknown", fps: 0, ...a.video, ...screen } } : {}),
								...(camera && a.cameraTrack
									? {
											cameraTrack: {
												...a.cameraTrack,
												width: Math.round(camera.width),
												height: Math.round(camera.height),
											},
										}
									: {}),
							}
						: a;
				}),
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [document]);
}

function cameraKey(asset: AxcutAsset): string {
	return `${asset.id}:camera:${asset.cameraTrack?.sourcePath ?? ""}`;
}

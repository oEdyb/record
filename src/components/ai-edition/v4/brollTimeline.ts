import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { buildTimelinePlaybackProjection } from "@/lib/ai-edition/timeline/timelineMap";
import { projectVideoOverlays, resolveVisibleClips } from "@/native/sceneDescription";

export function brollTimeline(document: AxcutDocument) {
	const visible = resolveVisibleClips(document);
	const projection = buildTimelinePlaybackProjection(visible, document.timeline.clips);
	const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
	return (document.videoOverlays ?? []).flatMap((overlay) => {
		const asset = assets.get(overlay.assetId);
		if (!asset) return [];
		return projectVideoOverlays({ ...document, videoOverlays: [overlay] }, visible, false).flatMap(
			(fragment) => {
				if (fragment.clipIndex === undefined) return [];
				const part = projection[fragment.clipIndex];
				if (!part) return [];
				const start = part.playbackStartSec + fragment.startSec - part.segment.sourceStartSec;
				const end = part.playbackStartSec + fragment.endSec - part.segment.sourceStartSec;
				if (end <= start) return [];
				return [
					{
						key: `${overlay.id}:${fragment.clipIndex}:${fragment.startSec}`,
						id: overlay.id,
						label: asset.label,
						path: asset.originalPath,
						start,
						end,
						sourceOffsetSec: fragment.sourceOffsetSec,
					},
				];
			},
		);
	});
}

import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import type { AxcutDocument, AxcutTrimRange, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import type { SpeedRegion } from "@/lib/ai-edition/timeline/speed";

export interface ReviewPreviewRegions {
	zoomRegions: AxcutZoomRegion[];
	speedRegions: SpeedRegion[];
	cameraFullscreenRegions: CameraFullscreenRegion[];
	trimRanges: AxcutTrimRange[];
}

/**
 * The region arrays the review preview plays back, read straight from the document.
 * Projects edited before review became the only shell keep their zooms, speed changes,
 * Full Camera spans and cuts. Speed and Full Camera regions live on `legacyEditor` and
 * are only read once a project id is loaded, as the old editor timeline did.
 */
export function selectReviewPreviewRegions(
	document: AxcutDocument | null,
	projectId: string | null,
): ReviewPreviewRegions {
	const hasDoc = document !== null && projectId !== null;
	const legacy = hasDoc ? (document.legacyEditor as Record<string, unknown> | null) : null;
	return {
		zoomRegions: document?.zoomRanges ?? [],
		trimRanges: document?.timeline.trimRanges ?? [],
		speedRegions: hasDoc ? ((legacy?.speedRegions as SpeedRegion[] | undefined) ?? []) : [],
		cameraFullscreenRegions: hasDoc
			? ((legacy?.cameraFullscreenRegions as CameraFullscreenRegion[] | undefined) ?? [])
			: [],
	};
}

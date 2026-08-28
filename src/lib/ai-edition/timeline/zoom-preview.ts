// Live-preview zoom transform for the new editor's CSS-based preview stack.
//
// Reuses the legacy editor's region math (`findDominantRegion`,
// `computeZoomTransform`) so zoom-in/out easing, region priority, and focus
// resolution stay identical between the two editors — only the output
// differs: a CSS translate/scale pair instead of a Pixi container transform.
//
// `computeZoomTransform` is called with a unit stage ({width:1, height:1}),
// which makes its pixel-space output already a fraction of the preview
// box — exactly what CSS `translate(x%, y%)` expects (percentages resolve
// against the transformed element's own layout box).

import type {
	CursorTelemetryPoint,
	ZoomRegion as LegacyZoomRegion,
} from "@/components/video-editor/types";
import { getZoomScale } from "@/components/video-editor/types";
import { resolvePlaybackSegments } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip, AxcutTrimRange, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import {
	buildZoomVisualEnvelopes,
	findDominantRegion,
	type ZoomVisualEnvelope,
} from "@/lib/zoomMath/zoomRegionUtils";
import { computeZoomTransform } from "@/lib/zoomMath/zoomTransform";

export interface ZoomPreviewTransform {
	scale: number;
	translateXPercent: number;
	translateYPercent: number;
}

export const IDENTITY_ZOOM_TRANSFORM: ZoomPreviewTransform = {
	scale: 1,
	translateXPercent: 0,
	translateYPercent: 0,
};

export interface ZoomPlaybackSegment {
	startMs: number;
	endMs: number;
}

/**
 * Keep the browser preview on the same per-clip/per-trim region slice that the
 * native compositor receives. Raw timeline time stays unchanged; only regions
 * outside the active kept segment are removed from connected-pan matching.
 */
export function buildZoomPlaybackSegments(
	clips: AxcutClip[],
	trimRanges: AxcutTrimRange[],
): ZoomPlaybackSegment[] {
	return [...clips]
		.sort((left, right) => left.timelineStartSec - right.timelineStartSec)
		.flatMap((clip) =>
			resolvePlaybackSegments([clip], trimRanges).map((segment) => ({
				startMs: (clip.timelineStartSec + segment.sourceStartSec - clip.sourceStartSec) * 1_000,
				endMs:
					(clip.timelineStartSec +
						(segment.sourceEndSec ?? segment.sourceStartSec) -
						clip.sourceStartSec) *
					1_000,
			})),
		);
}

function regionsInPlaybackSegment(regions: AxcutZoomRegion[], segment: ZoomPlaybackSegment) {
	return regions.flatMap((region) => {
		const startMs = Math.max(region.startMs, segment.startMs);
		const endMs = Math.min(region.endMs, segment.endMs);
		return endMs > startMs ? [{ ...region, startMs, endMs }] : [];
	});
}

function regionsInActivePlaybackSegment(
	regions: AxcutZoomRegion[],
	virtualTimeMs: number,
	segments: ZoomPlaybackSegment[],
) {
	const active = segments.find(
		(segment, index) =>
			virtualTimeMs >= segment.startMs &&
			(virtualTimeMs < segment.endMs ||
				(index === segments.length - 1 && virtualTimeMs === segment.endMs)),
	);
	return active ? regionsInPlaybackSegment(regions, active) : [];
}

/**
 * Build the timeline's passive motion bands from the same kept playback
 * segments that preview uses. Clip and trim boundaries are hard barriers: a
 * nearby Zoom on the other side cannot look connected when preview/export
 * resolve it as a separate passage.
 */
export function buildZoomTimelineEnvelopes(
	regions: AxcutZoomRegion[],
	segments?: ZoomPlaybackSegment[],
): ZoomVisualEnvelope[] {
	if (segments === undefined) return buildZoomVisualEnvelopes(regions);
	if (segments.length === 0) return [];
	return segments.flatMap((segment) =>
		buildZoomVisualEnvelopes(regionsInPlaybackSegment(regions, segment)).flatMap((envelope) => {
			const startMs = Math.max(segment.startMs, envelope.startMs);
			const endMs = Math.min(segment.endMs, envelope.endMs);
			return endMs > startMs ? [{ ...envelope, startMs, endMs }] : [];
		}),
	);
}

const UNIT_STAGE = { width: 1, height: 1 };
const UNIT_MASK = { x: 0, y: 0, width: 1, height: 1 };

function toLegacyZoomRegion(region: AxcutZoomRegion): LegacyZoomRegion {
	return {
		id: region.id,
		startMs: region.startMs,
		endMs: region.endMs,
		depth: region.depth,
		focus: region.focus,
		focusMode: region.focusMode,
		rotationPreset: region.rotationPreset,
		customScale: region.customScale,
		motionStyle: region.motionStyle,
		motionSpeed: region.motionSpeed,
		source: region.source,
		directionGroupId: region.directionGroupId,
	};
}

/**
 * Resolves the zoom transform to apply to the preview at a given point on
 * the virtual (edited) timeline. `virtualTimeMs` must be in the same
 * coordinate space as `zoomRegion.startMs`/`endMs` (the timeline shown in
 * the ruler, not raw source-media time).
 *
 * Zoom transition windows stay in source time, matching native preview and
 * export. A speed region speeds the Zoom together with the recorded content.
 */
export function computeZoomPreviewTransform(
	zoomRegions: AxcutZoomRegion[],
	virtualTimeMs: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	playbackSegments?: ZoomPlaybackSegment[],
): ZoomPreviewTransform {
	if (zoomRegions.length === 0) return IDENTITY_ZOOM_TRANSFORM;

	const activeRegions =
		playbackSegments === undefined
			? zoomRegions
			: regionsInActivePlaybackSegment(zoomRegions, virtualTimeMs, playbackSegments);
	const legacyRegions = activeRegions.map(toLegacyZoomRegion);
	const dominant = findDominantRegion(legacyRegions, virtualTimeMs, {
		cursorTelemetry,
		// Keep nearby regions at full scale and pan between their focal points.
		// This avoids a needless zoom-out/zoom-in pulse during one short action.
		connectZooms: true,
	});
	if (!dominant.region || dominant.strength <= 0) return IDENTITY_ZOOM_TRANSFORM;

	const zoomScale = dominant.blendedScale ?? getZoomScale(dominant.region);
	const transform = computeZoomTransform({
		stageSize: UNIT_STAGE,
		baseMask: UNIT_MASK,
		zoomScale,
		zoomProgress: dominant.strength,
		focusX: dominant.region.focus.cx,
		focusY: dominant.region.focus.cy,
	});

	return {
		scale: transform.scale,
		translateXPercent: transform.x * 100,
		translateYPercent: transform.y * 100,
	};
}

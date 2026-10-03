import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { TRANSITION_WINDOW_MS } from "./constants";
import { applyMotionCurve, DEFAULT_CAMERA_MOTION_STYLE, normalizeMotionSpeed } from "./motionCurve";

// The return to the normal layout should feel gentler than the expansion, so the
// lead-out window is stretched relative to the lead-in one.
const LEAD_OUT_WINDOW_MS = TRANSITION_WINDOW_MS * 1.5;

/** Shared contained phase boundaries for rendering and timeline decoration. */
/** Largest camera growth an emphasis region may ask for; preview and export clamp to it. */
export const MAX_CAMERA_EMPHASIS_SCALE = 2;

export function cameraTransitionTiming(region: CameraFullscreenRegion) {
	const halfDuration = Math.max(0, region.endMs - region.startMs) / 2;
	const motionSpeed = normalizeMotionSpeed(region.motionSpeed);
	const instant = region.motionStyle === "instant";
	const leadInWindow = instant ? 0 : Math.min(TRANSITION_WINDOW_MS / motionSpeed, halfDuration);
	const leadOutWindow = instant ? 0 : Math.min(LEAD_OUT_WINDOW_MS / motionSpeed, halfDuration);
	return {
		leadInWindow,
		leadOutWindow,
		leadInEnd: region.startMs + leadInWindow,
		leadOutStart: region.endMs - leadOutWindow,
	};
}

/**
 * Ease-in/hold/ease-out envelope for a single region. Unlike zoom's
 * `computeRegionStrength` (which anticipates the transition before `startMs`),
 * Full Camera must stay fully contained within [startMs, endMs]: progress is
 * exactly 0 at startMs, eases up to 1 within a lead-in window that starts at
 * startMs, holds at 1, then eases back down to exactly 0 at endMs (over a longer
 * window than the lead-in). Outside [startMs, endMs] progress is always 0. The
 * transition windows are clamped to at most half the region's duration so short
 * regions still ease in/out fully within their own bounds instead of overlapping.
 */
function computeCameraFullscreenRegionStrength(
	region: CameraFullscreenRegion,
	timeMs: number,
): number {
	if (timeMs < region.startMs || timeMs >= region.endMs) {
		return 0;
	}

	const motionStyle = region.motionStyle ?? DEFAULT_CAMERA_MOTION_STYLE;
	const { leadInWindow, leadOutWindow, leadInEnd, leadOutStart } = cameraTransitionTiming(region);

	if (timeMs < leadInEnd) {
		const progress = leadInWindow > 0 ? (timeMs - region.startMs) / leadInWindow : 1;
		return applyMotionCurve(motionStyle, progress);
	}

	if (timeMs <= leadOutStart) {
		return 1;
	}

	const progress = leadOutWindow > 0 ? (region.endMs - timeMs) / leadOutWindow : 0;
	return applyMotionCurve(motionStyle, progress);
}

export interface CameraLayoutState {
	progress: number;
	mode: "fullscreen" | "emphasis";
	cameraScale: number;
	/** Extra scale about the camera's center from the region's drift, already faded by `progress`. */
	driftScale: number;
}

/**
 * Drift factor at a frame: ease-in-out push from 1 to `scaleTo` until the last `releaseSec`,
 * then a fast ease-out return to exactly 1 at `endMs`. Shared formula with the native compositor.
 */
export function computeCameraDriftFactor(region: CameraFullscreenRegion, timeMs: number): number {
	const drift = region.drift;
	if (!drift || timeMs < region.startMs || timeMs >= region.endMs) return 1;
	const scaleTo = Math.max(1, Math.min(1.6, drift.scaleTo));
	if (scaleTo <= 1) return 1;
	const releaseMs = Math.min(
		Math.max(0, drift.releaseSec) * 1000,
		(region.endMs - region.startMs) / 2,
	);
	const pushEndMs = region.endMs - releaseMs;
	if (timeMs < pushEndMs) {
		const p =
			pushEndMs > region.startMs ? (timeMs - region.startMs) / (pushEndMs - region.startMs) : 1;
		return 1 + (scaleTo - 1) * ((1 - Math.cos(Math.PI * p)) / 2);
	}
	const q = releaseMs > 0 ? (timeMs - pushEndMs) / releaseMs : 1;
	return scaleTo - (scaleTo - 1) * (1 - (1 - q) * (1 - q));
}

/**
 * Resolve the strongest camera-layout region at a frame. Legacy regions default to
 * Full Camera. The renderer reads this pure value per frame; React stores no animation
 * state and preview/export therefore use the same timeline clock.
 */
export function computeCameraLayoutState(
	regions: CameraFullscreenRegion[],
	timeMs: number,
): CameraLayoutState {
	let state: CameraLayoutState = { progress: 0, mode: "fullscreen", cameraScale: 1, driftScale: 1 };
	for (const region of regions) {
		const progress = computeCameraFullscreenRegionStrength(region, timeMs);
		if (progress <= state.progress) continue;
		state = {
			progress,
			mode: region.mode === "emphasis" ? "emphasis" : "fullscreen",
			cameraScale:
				region.mode === "emphasis"
					? Math.max(1, Math.min(MAX_CAMERA_EMPHASIS_SCALE, region.cameraScale ?? 1.35))
					: 1,
			driftScale: 1 + (computeCameraDriftFactor(region, timeMs) - 1) * progress,
		};
	}
	return state;
}

/**
 * Returns the Full Camera progress (0..1) at a given time: 0 = webcam at its normal
 * layout, 1 = webcam fully covering the canvas. Ramps in/out at the edges of the
 * dominant region using the same easing as zoom. When multiple regions overlap
 * (shouldn't normally happen given timeline overlap guards, but is handled
 * defensively) the strongest one wins.
 */
export function computeCameraFullscreenProgress(
	regions: CameraFullscreenRegion[],
	timeMs: number,
): number {
	let strongest = 0;
	for (const region of regions) {
		if (region.mode === "emphasis") continue;
		const strength = computeCameraFullscreenRegionStrength(region, timeMs);
		if (strength > strongest) {
			strongest = strength;
		}
	}
	return strongest;
}

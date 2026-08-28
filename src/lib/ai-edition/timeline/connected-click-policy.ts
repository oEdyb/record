import type { MotionSpeed } from "@/lib/zoomMath/motionCurve";
import { CHAINED_ZOOM_PAN_GAP_MS } from "@/lib/zoomMath/zoomRegionUtils";
import { MAX_ZOOM_SCALE } from "./zoom-scale";

/**
 * All tunable behavior for automatic connected click sequences.
 *
 * The planner owns intent and safety. The normal Zoom region renderer owns
 * interpolation, preview, export, editing, and user-selected Motion/Speed.
 */
export interface ConnectedClickPolicy {
	clickDedupeMs: number;
	clickDedupeDistance: number;
	chainGapMs: number;
	clickChainMaximumDurationMs: number;
	passageConnectionGapMs: number;
	stationaryBridgeMaximumGapMs: number;
	stationaryBridgeMaximumMovement: number;
	stationaryBridgeMaximumFocusDistance: number;
	passageMinimumStableScale: number;
	passageScaleSearchSteps: number;
	dragMinimumDurationMs: number;
	dragMaximumDurationMs: number;
	dragMinimumDistance: number;
	dragMinimumPath: number;
	dragFramingPadding: number;
	shortDragDestinationDelayMs: number;
	targetMergeMs: number;
	targetMergeDistance: number;
	targetArrivalLookbackMs: number;
	targetArrivalRadius: number;
	requestedScale: number;
	safeInset: number;
	deadZoneWidthRatio: number;
	deadZoneHeightRatio: number;
	minimumFocusChangeDistance: number;
	anticipationMs: number;
	minimumPanMs: number;
	maximumPanMs: number;
	panDistanceForMaximum: number;
	panMotionSpeeds: readonly MotionSpeed[];
	entryMotionSpeed: MotionSpeed;
	leadBeforeFirstClickMs: number;
	holdAfterLastClickMs: number;
	minimumTargetHoldMs: number;
	safetyFramesPerSecond: number;
	scaleSearchIterations: number;
	minimumUsefulScale: number;
}

/** Normal automatic depth before the user changes the project Max Zoom setting. */
export const DEFAULT_AUTOMATIC_DIRECTION_MAX_SCALE = 1.65;

/** Automatic and manual Zoom share the renderer's validated upper bound. */
export const AUTOMATIC_DIRECTION_MAX_SCALE = MAX_ZOOM_SCALE;

export const DEFAULT_CONNECTED_CLICK_POLICY: ConnectedClickPolicy = Object.freeze({
	clickDedupeMs: 120,
	clickDedupeDistance: 0.025,
	chainGapMs: 1_800,
	clickChainMaximumDurationMs: 6_000,
	passageConnectionGapMs: CHAINED_ZOOM_PAN_GAP_MS,
	stationaryBridgeMaximumGapMs: 4_000,
	stationaryBridgeMaximumMovement: 0.025,
	stationaryBridgeMaximumFocusDistance: 0.18,
	passageMinimumStableScale: 1.35,
	passageScaleSearchSteps: 12,
	dragMinimumDurationMs: 180,
	dragMaximumDurationMs: 8_000,
	dragMinimumDistance: 0.04,
	dragMinimumPath: 0.06,
	dragFramingPadding: 0.035,
	shortDragDestinationDelayMs: 0,
	targetMergeMs: 1_600,
	targetMergeDistance: 0.08,
	targetArrivalLookbackMs: 450,
	targetArrivalRadius: 0.04,
	requestedScale: DEFAULT_AUTOMATIC_DIRECTION_MAX_SCALE,
	safeInset: 0.18,
	deadZoneWidthRatio: 0.5,
	deadZoneHeightRatio: 0.7,
	minimumFocusChangeDistance: 0.002,
	anticipationMs: 100,
	minimumPanMs: 400,
	maximumPanMs: 700,
	panDistanceForMaximum: 0.5,
	panMotionSpeeds: [1.5, 2] as const,
	entryMotionSpeed: 2,
	leadBeforeFirstClickMs: 350,
	holdAfterLastClickMs: 900,
	minimumTargetHoldMs: 80,
	safetyFramesPerSecond: 60,
	scaleSearchIterations: 12,
	minimumUsefulScale: 1.05,
});

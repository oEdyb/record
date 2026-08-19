import { clamp01 } from "../../utils/math";
import { easeOutScreenStudio } from "./mathUtils";

export const MOTION_STYLE_VALUES = ["smooth", "snappy", "linear", "instant"] as const;
export type MotionStyle = (typeof MOTION_STYLE_VALUES)[number];

// A missing value belongs to a project created before motion profiles existed.
// Those projects rendered with the fast Screen Studio curve, so absence must
// keep meaning Snappy. Every new region stores Smooth explicitly.
export const DEFAULT_ZOOM_MOTION_STYLE: MotionStyle = "snappy";
export const DEFAULT_CAMERA_MOTION_STYLE: MotionStyle = "snappy";
export const NEW_ZOOM_MOTION_STYLE: MotionStyle = "smooth";
export const NEW_CAMERA_MOTION_STYLE: MotionStyle = "smooth";
export const MOTION_SPEED_VALUES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type MotionSpeed = (typeof MOTION_SPEED_VALUES)[number];
export const DEFAULT_MOTION_SPEED: MotionSpeed = 1;

export function isMotionStyle(value: unknown): value is MotionStyle {
	return typeof value === "string" && MOTION_STYLE_VALUES.includes(value as MotionStyle);
}

export function isMotionSpeed(value: unknown): value is MotionSpeed {
	return typeof value === "number" && MOTION_SPEED_VALUES.includes(value as MotionSpeed);
}

export function normalizeMotionSpeed(value: unknown): MotionSpeed {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MOTION_SPEED;
	return MOTION_SPEED_VALUES.reduce((nearest, candidate) =>
		Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest,
	);
}

/**
 * Convert linear authored time into deterministic render progress.
 *
 * Smooth is quintic smootherstep: both velocity and acceleration reach zero at
 * each endpoint. Snappy preserves the previous Screen Studio-style fast settle.
 * Instant is Hold interpolation: it changes on the first frame after the boundary.
 */
export function applyMotionCurve(style: MotionStyle, value: number): number {
	const t = clamp01(value);
	switch (style) {
		case "smooth":
			return t * t * t * (t * (t * 6 - 15) + 10);
		case "snappy":
			return easeOutScreenStudio(t);
		case "linear":
			return t;
		case "instant":
			return t <= 0 ? 0 : 1;
	}
}

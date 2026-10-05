import type { AspectRatio } from "@/utils/aspectRatioUtils";
import { toAspectRatioToken } from "@/utils/aspectRatioUtils";

export interface ScreenFocalPoint {
	cx: number;
	cy: number;
}

export interface ScreenFraming {
	scale: number;
	focalPoint: ScreenFocalPoint;
}

export type ScreenFramingByVariant = Record<string, ScreenFraming>;

export const MIN_SCREEN_FRAMING_SCALE = 1;
export const MAX_SCREEN_FRAMING_SCALE = 4;
const DEFAULT_SCREEN_FRAMING: ScreenFraming = {
	scale: MIN_SCREEN_FRAMING_SCALE,
	focalPoint: { cx: 0.5, cy: 0.5 },
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function normalizeScreenFraming(value: unknown): ScreenFraming {
	if (!value || typeof value !== "object") return cloneScreenFraming(DEFAULT_SCREEN_FRAMING);
	const candidate = value as Record<string, unknown>;
	const focalPoint =
		candidate.focalPoint && typeof candidate.focalPoint === "object"
			? (candidate.focalPoint as Record<string, unknown>)
			: null;
	const scale =
		typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
			? Math.min(MAX_SCREEN_FRAMING_SCALE, Math.max(MIN_SCREEN_FRAMING_SCALE, candidate.scale))
			: DEFAULT_SCREEN_FRAMING.scale;
	const cx =
		typeof focalPoint?.cx === "number" && Number.isFinite(focalPoint.cx)
			? clamp01(focalPoint.cx)
			: DEFAULT_SCREEN_FRAMING.focalPoint.cx;
	const cy =
		typeof focalPoint?.cy === "number" && Number.isFinite(focalPoint.cy)
			? clamp01(focalPoint.cy)
			: DEFAULT_SCREEN_FRAMING.focalPoint.cy;
	return { scale, focalPoint: { cx, cy } };
}

export function normalizeScreenFramingByVariant(value: unknown): ScreenFramingByVariant {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([key]) => key.length > 0 && key.length <= 64)
		.slice(0, 32)
		.map(([key, framing]) => [key, normalizeScreenFraming(framing)] as const);
	return Object.fromEntries(entries);
}

export function screenFramingVariantKey(
	aspectRatio: AspectRatio,
	outputResolution?: { width: number; height: number } | null,
): string {
	return (
		(outputResolution
			? toAspectRatioToken(outputResolution.width, outputResolution.height)
			: null) ?? aspectRatio
	);
}

export function resolveScreenFraming(
	framingByVariant: ScreenFramingByVariant,
	variantKey: string,
): ScreenFraming {
	return normalizeScreenFraming(framingByVariant[variantKey]);
}

export function setScreenFramingForVariant(
	framingByVariant: ScreenFramingByVariant,
	variantKey: string,
	framing: ScreenFraming,
): ScreenFramingByVariant {
	return {
		...framingByVariant,
		[variantKey]: normalizeScreenFraming(framing),
	};
}

function cloneScreenFraming(framing: ScreenFraming): ScreenFraming {
	return { scale: framing.scale, focalPoint: { ...framing.focalPoint } };
}

export function screenVisibleFractions({
	sourceWidth,
	sourceHeight,
	boxWidth,
	boxHeight,
	cover,
	scale,
}: {
	sourceWidth: number;
	sourceHeight: number;
	boxWidth: number;
	boxHeight: number;
	cover: boolean;
	scale: number;
}): { width: number; height: number } {
	const sourceAspect = Math.max(1, sourceWidth) / Math.max(1, sourceHeight);
	const boxAspect = Math.max(1, boxWidth) / Math.max(1, boxHeight);
	let width = 1;
	let height = 1;
	if (cover) {
		if (boxAspect >= sourceAspect) height = sourceAspect / boxAspect;
		else width = boxAspect / sourceAspect;
	}
	const normalizedScale = Math.min(
		MAX_SCREEN_FRAMING_SCALE,
		Math.max(MIN_SCREEN_FRAMING_SCALE, scale),
	);
	return { width: width / normalizedScale, height: height / normalizedScale };
}

export function dragScreenFocalPoint({
	start,
	deltaX,
	deltaY,
	boxWidth,
	boxHeight,
	visible,
}: {
	start: ScreenFocalPoint;
	deltaX: number;
	deltaY: number;
	boxWidth: number;
	boxHeight: number;
	visible: { width: number; height: number };
}): ScreenFocalPoint {
	const travelX = Math.max(0, 1 - visible.width);
	const travelY = Math.max(0, 1 - visible.height);
	return {
		cx:
			travelX <= 1e-6
				? 0.5
				: clamp01(start.cx - (deltaX / Math.max(1, boxWidth)) * (visible.width / travelX)),
		cy:
			travelY <= 1e-6
				? 0.5
				: clamp01(start.cy - (deltaY / Math.max(1, boxHeight)) * (visible.height / travelY)),
	};
}

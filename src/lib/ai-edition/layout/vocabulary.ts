import { computeCompositeLayout, type Size } from "../../compositeLayout";
import { screenFramingVariantKey, setScreenFramingForVariant } from "../../screenFraming";
import { pickOutputDims } from "../document/outputFormat";
import type { AxcutDocument } from "../schema";
import { type EditorSettingsSnapshot, getEditorSettings } from "../store/editorSettings";
import {
	CAMERA_ANCHORS,
	CAMERA_SIZES,
	type CameraAnchor,
	type CameraSize,
	DEFAULT_SAFE_MARGIN_PERCENT,
} from "./schema";

export { CAMERA_ANCHORS, CAMERA_SIZES, DEFAULT_SAFE_MARGIN_PERCENT } from "./schema";

const axes: Record<CameraAnchor, readonly [number, number]> = {
	"top-left": [0, 0],
	top: [0.5, 0],
	"top-right": [1, 0],
	left: [0, 0.5],
	center: [0.5, 0.5],
	right: [1, 0.5],
	"bottom-left": [0, 1],
	bottom: [0.5, 1],
	"bottom-right": [1, 1],
};

export function anchorPosition(
	anchor: CameraAnchor,
	canvasSize: Size = { width: 1, height: 1 },
	cameraSize: Size = { width: 0, height: 0 },
	safeMarginPercent = DEFAULT_SAFE_MARGIN_PERCENT,
): { cx: number; cy: number } {
	const margin = (Math.min(canvasSize.width, canvasSize.height) * safeMarginPercent) / 100;
	const insetX = Math.min(0.5, (margin + cameraSize.width / 2) / canvasSize.width);
	const insetY = Math.min(0.5, (margin + cameraSize.height / 2) / canvasSize.height);
	const [x, y] = axes[anchor];
	return { cx: insetX + x * (1 - 2 * insetX), cy: insetY + y * (1 - 2 * insetY) };
}

export function nearestAnchor(position: { cx: number; cy: number }): CameraAnchor {
	const axis = (value: number) => (value < 1 / 3 ? 0 : value > 2 / 3 ? 1 : 0.5);
	return (
		CAMERA_ANCHORS.find(
			(name) => axes[name][0] === axis(position.cx) && axes[name][1] === axis(position.cy),
		) ?? "center"
	);
}

export function sizePercent(size: CameraSize | number): number {
	return typeof size === "number" ? size : CAMERA_SIZES[size];
}

export function nearestSize(percent: number): CameraSize {
	return (Object.keys(CAMERA_SIZES) as CameraSize[]).reduce(
		(best, name) =>
			Math.abs(CAMERA_SIZES[name] - percent) < Math.abs(CAMERA_SIZES[best] - percent) ? name : best,
		"XS",
	);
}

export function resolveClipEditorSettings(
	document: AxcutDocument,
	clipId?: string,
	geometry: { canvasSize?: Size; webcamSize?: Size | null } = {},
): EditorSettingsSnapshot {
	const settings = getEditorSettings(document);
	const override = clipId ? document.clipLayouts?.[clipId] : undefined;
	const resolved = { ...settings };
	if (override?.cameraSize !== undefined)
		resolved.webcamSizePreset = sizePercent(override.cameraSize);
	if (override?.cameraShape !== undefined) resolved.webcamMaskShape = override.cameraShape;
	if (override?.cameraLayoutPreset !== undefined)
		resolved.webcamLayoutPreset = override.cameraLayoutPreset;
	if (override?.screenFraming !== undefined)
		resolved.screenFramingByVariant = setScreenFramingForVariant(
			settings.screenFramingByVariant,
			screenFramingVariantKey(settings.aspectRatio, settings.outputResolution),
			override.screenFraming,
		);
	const anchor = override?.cameraAnchor ?? settings.cameraAnchor;
	if (anchor !== undefined) {
		resolved.cameraAnchor = anchor;
		if (typeof anchor !== "string") resolved.webcamPosition = anchor;
		else {
			const canvas =
				geometry.canvasSize ??
				pickOutputDims(document, settings.aspectRatio, {}, settings.outputResolution);
			const layout = computeCompositeLayout({
				canvasSize: canvas,
				screenSize: canvas,
				webcamSize: geometry.webcamSize ?? { width: 960, height: 720 },
				layoutPreset: "picture-in-picture",
				webcamSizePreset: resolved.webcamSizePreset,
				webcamMaskShape: resolved.webcamMaskShape,
				webcamAspectRatio: resolved.webcamAspectRatio,
			});
			resolved.webcamPosition = anchorPosition(
				anchor,
				canvas,
				layout?.webcamRect ?? { width: 0, height: 0 },
				settings.safeMarginPercent,
			);
		}
	}
	return resolved;
}

export function assertClipLayoutSupported(document: AxcutDocument, clipId: string): void {
	const override = document.clipLayouts?.[clipId];
	if (!override) return;
	if (override.cameraLayoutPreset !== undefined) {
		throw new Error(
			"CLIP_LAYOUT_UNSUPPORTED: Per-clip cameraLayoutPreset changes require native preset and reactive-zoom support.",
		);
	}
	if (override.screenFraming !== undefined) {
		throw new Error(
			"CLIP_LAYOUT_UNSUPPORTED: Per-clip screenFraming changes require native framing support to preserve timeline zooms.",
		);
	}
}

export const ZOOM_SCALES = { S: 1.25, M: 1.5, L: 2, XL: 2.5 } as const;
export const CAMERA_EMPHASIS_SCALES = { S: 1.15, M: 1.35, L: 1.65, XL: 2 } as const;
export const SPEECH_MOTION = {
	quick: { motionStyle: "snappy", motionSpeed: 1.5 },
	normal: { motionStyle: "smooth", motionSpeed: 1 },
	slow: { motionStyle: "smooth", motionSpeed: 0.5 },
} as const;
export function textSizeFraction(
	size: CameraSize,
	style: "card" | "lower-third" | "label" = "card",
) {
	const step = { XS: 1, S: 2, M: 3, L: 4, XL: 5 }[size];
	return [0.02, 0.03, 0.045, 0.06, 0.08, 0.11, 0.15][
		step + (style === "label" ? -1 : style === "lower-third" ? 1 : 0)
	];
}

export function overlayRect(
	kind: "text" | "broll",
	anchor: CameraAnchor,
	size: CameraSize,
	canvas: Size,
	safeMarginPercent = DEFAULT_SAFE_MARGIN_PERCENT,
	style: "card" | "lower-third" | "label" = "card",
	frameHeight = canvas.height,
) {
	const height =
		kind === "broll"
			? (sizePercent(size) / 100) * canvas.height
			: textSizeFraction(size, style) * 2.2 * frameHeight;
	const width = Math.min(
		canvas.width * 0.92,
		kind === "broll"
			? (height * 16) / 9
			: height * (style === "lower-third" ? 7 : style === "label" ? 4 : 5),
	);
	const center = anchorPosition(anchor, canvas, { width, height }, safeMarginPercent);
	return {
		x: (center.cx - width / canvas.width / 2) * 100,
		y: (center.cy - height / canvas.height / 2) * 100,
		width: (width / canvas.width) * 100,
		height: (height / canvas.height) * 100,
	};
}

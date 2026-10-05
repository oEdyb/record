import { z } from "zod";

export const CAMERA_ANCHORS = [
	"top-left",
	"top",
	"top-right",
	"left",
	"center",
	"right",
	"bottom-left",
	"bottom",
	"bottom-right",
] as const;
export const CAMERA_SIZES = { XS: 14, S: 20, M: 26, L: 34, XL: 44 } as const;
export const DEFAULT_SAFE_MARGIN_PERCENT = 4;
export const cameraAnchorSchema = z.union([
	z.enum(CAMERA_ANCHORS),
	z.strictObject({ cx: z.number().finite().min(0).max(1), cy: z.number().finite().min(0).max(1) }),
]);
const cameraSizeSchema = z.union([
	z.enum(["XS", "S", "M", "L", "XL"]),
	z.number().finite().min(10).max(80),
]);
export const clipLayoutOverrideSchema = z.strictObject({
	cameraAnchor: cameraAnchorSchema.optional(),
	cameraSize: cameraSizeSchema.optional(),
	cameraShape: z.enum(["rectangle", "circle", "square", "rounded", "squircle"]).optional(),
	cameraLayoutPreset: z
		.enum(["picture-in-picture", "vertical-stack", "dual-frame", "no-webcam"])
		.optional(),
	screenFraming: z
		.strictObject({
			scale: z.number().finite().min(1).max(4),
			focalPoint: z.strictObject({
				cx: z.number().finite().min(0).max(1),
				cy: z.number().finite().min(0).max(1),
			}),
		})
		.optional(),
	captions: z.boolean().optional(),
});
export type CameraAnchor = (typeof CAMERA_ANCHORS)[number];
export type CameraSize = keyof typeof CAMERA_SIZES;
export type ClipLayoutOverride = z.infer<typeof clipLayoutOverrideSchema>;

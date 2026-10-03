import { z } from "zod";

export const overlayAnchorSchema = z.discriminatedUnion("kind", [
	z
		.strictObject({
			kind: z.literal("edited"),
			fromSec: z.number().finite().nonnegative(),
			toSec: z.number().finite().nonnegative(),
		})
		.refine((v) => v.toSec > v.fromSec),
	z
		.strictObject({
			kind: z.literal("words"),
			clipId: z.string().min(1),
			assetId: z.string().min(1).optional(),
			text: z.string().min(1).max(4000),
			sourceStartSec: z.number().finite().nonnegative(),
			sourceEndSec: z.number().finite().nonnegative(),
			minimumDurationSec: z.number().finite().nonnegative().optional(),
		})
		.refine((v) => v.sourceEndSec > v.sourceStartSec),
]);
export type OverlayAnchor = z.infer<typeof overlayAnchorSchema>;

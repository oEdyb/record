import { z } from "zod";

const seconds = z.number().finite().min(0).max(10_800);
export const audioAssetSchema = z.strictObject({
	id: z.string().min(1).max(256),
	label: z.string().min(1).max(256),
	originalPath: z.string().min(1).max(4096),
	durationSec: seconds.positive(),
});

/** Output-time placement is stable across video trims and speed changes; no implicit ripple. */
export const audioClipSchema = z
	.strictObject({
		id: z.string().min(1).max(256),
		assetId: z.string().min(1).max(256),
		startSec: seconds,
		endSec: seconds,
		sourceOffsetSec: seconds,
		gain: z.number().finite().min(0).max(4),
		fadeInSec: seconds,
		fadeOutSec: seconds,
	})
	.superRefine((clip, ctx) => {
		const duration = clip.endSec - clip.startSec;
		if (duration <= 0)
			ctx.addIssue({
				code: "custom",
				path: ["endSec"],
				message: "Audio clip must have positive duration.",
			});
		if (clip.fadeInSec + clip.fadeOutSec > duration)
			ctx.addIssue({
				code: "custom",
				path: ["fadeOutSec"],
				message: "Audio fades must fit inside the clip.",
			});
	});

export type AudioAsset = z.infer<typeof audioAssetSchema>;
export type AudioClip = z.infer<typeof audioClipSchema>;

export function validateAudioReferences(
	assets: readonly AudioAsset[],
	clips: readonly AudioClip[],
) {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	if (byId.size !== assets.length) throw new Error("Duplicate audio asset ID");
	if (new Set(clips.map((clip) => clip.id)).size !== clips.length)
		throw new Error("Duplicate audio clip ID");
	for (const clip of clips) {
		const asset = byId.get(clip.assetId);
		if (!asset) throw new Error(`Missing audio asset for clip ${clip.id}`);
		if (clip.sourceOffsetSec + clip.endSec - clip.startSec > asset.durationSec + 0.000001)
			throw new Error(`Audio clip ${clip.id} exceeds its source duration`);
	}
}

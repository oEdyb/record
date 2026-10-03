import type { AxcutDocument } from "../schema";
import { removeClip } from "./timeline";

/** Removes references only. Original media remains available for Undo. */
export function removeAssetFromDocument(doc: AxcutDocument, assetId: string): AxcutDocument {
	const assets = doc.assets.filter((a) => a.id !== assetId);
	const primaryAssetId =
		doc.project.primaryAssetId === assetId
			? (assets[0]?.id ?? undefined)
			: doc.project.primaryAssetId;
	const withoutAssetClips = doc.timeline.clips
		.filter((clip) => clip.assetId === assetId)
		.reduce((current, clip) => removeClip(current, clip.id), doc);
	const next: AxcutDocument = {
		...withoutAssetClips,
		assets,
		timeline: {
			...withoutAssetClips.timeline,
			trimRanges: withoutAssetClips.timeline.trimRanges.filter((r) => r.assetId !== assetId),
		},
		project: {
			...withoutAssetClips.project,
			primaryAssetId,
			updatedAt: new Date().toISOString(),
		},
	};
	return next;
}

import { createId } from "../../src/lib/ai-edition/document/ids";
import { rederiveRegionMs, resequenceClips } from "../../src/lib/ai-edition/document/timeline";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { findPhrase, resolveOverlaySpan } from "../../src/lib/ai-edition/timeline/overlayAnchors";
import { trimAppliesToClip } from "../../src/lib/ai-edition/timeline/trim-mapping";
import { resolveVisibleClips } from "../../src/native/sceneDescription";

export function replaceClipSource(document: AxcutDocument, clipId: string, assetId: string) {
	const clip = document.timeline.clips.find((c) => c.id === clipId);
	const asset = document.assets.find((a) => a.id === assetId);
	if (!clip) throw new Error("UNKNOWN_CLIP");
	if (!asset || !asset.durationSec)
		throw new Error("UNKNOWN_ASSET: Replacement needs a known positive video duration.");
	const sourceStartSec = clip.sourceStartSec < asset.durationSec ? clip.sourceStartSec : 0;
	const sourceEndSec =
		clip.sourceEndSec !== undefined && clip.sourceEndSec > sourceStartSec
			? Math.min(clip.sourceEndSec, asset.durationSec)
			: asset.durationSec;
	const keptTrims: string[] = [];
	const droppedTrims: { id: string; startSec: number; endSec: number }[] = [];
	const trimRanges = document.timeline.trimRanges.flatMap((trim) => {
		if (!trimAppliesToClip(trim, clip)) return [trim];
		const shared =
			!trim.clipId &&
			document.timeline.clips.some((c) => c.id !== clip.id && trimAppliesToClip(trim, c));
		if (trim.startSec < sourceStartSec || trim.endSec > sourceEndSec) {
			droppedTrims.push({ id: trim.id, startSec: trim.startSec, endSec: trim.endSec });
			return shared ? [trim] : [];
		}
		const replacement = { ...trim, id: shared ? createId("trim") : trim.id, clipId, assetId };
		keptTrims.push(replacement.id);
		return shared ? [trim, replacement] : [replacement];
	});
	const clips = resequenceClips(
		document.timeline.clips.map((c) =>
			c.id === clipId
				? {
						...c,
						assetId,
						sourceStartSec,
						sourceEndSec,
						timelineStartSec: 0,
						timelineEndSec: 0,
						wordRefs: (document.transcripts.find((t) => t.assetId === assetId)?.words ?? [])
							.filter((w) => w.startSec >= sourceStartSec && w.endSec <= sourceEndSec)
							.map((w) => w.id),
					}
				: c,
		),
	);
	let candidate = rederiveRegionMs(
		{ ...document, timeline: { ...document.timeline, clips, trimRanges } },
		clips,
	);
	const reanchor = <
		T extends { anchor?: import("../../src/lib/ai-edition/schema/overlayAnchor").OverlayAnchor },
	>(
		region: T,
	): T => {
		const anchor = region.anchor;
		if (anchor?.kind !== "words" || anchor.clipId !== clipId) return region;
		const matches = findPhrase(candidate, anchor.text, clipId);
		const found =
			matches.find(
				(m) =>
					Math.abs(m.sourceStartSec - anchor.sourceStartSec) < 0.001 &&
					Math.abs(m.sourceEndSec - anchor.sourceEndSec) < 0.001,
			) ?? (matches.length === 1 ? matches[0] : undefined);
		return {
			...region,
			anchor: {
				...anchor,
				assetId,
				...(found
					? { sourceStartSec: found.sourceStartSec, sourceEndSec: found.sourceEndSec }
					: {}),
			},
		};
	};
	// Keep lost legacy overlays visible to overlay.orphaned instead of silently deleting them.
	candidate = documentSchema.parse({
		...candidate,
		annotations: [
			...candidate.annotations,
			...document.annotations.filter((a) => !candidate.annotations.some((b) => b.id === a.id)),
		].map(reanchor),
		videoOverlays: [
			...(candidate.videoOverlays ?? []),
			...(document.videoOverlays ?? []).filter(
				(a) => !candidate.videoOverlays?.some((b) => b.id === a.id),
			),
		].map(reanchor),
	});
	const regions = (doc: AxcutDocument) => [
		...doc.zoomRanges,
		...doc.annotations,
		...(doc.videoOverlays ?? []),
		...(Array.isArray(doc.legacyEditor?.cameraFullscreenRegions)
			? doc.legacyEditor.cameraFullscreenRegions
			: []),
		...(Array.isArray(doc.legacyEditor?.speedRegions) ? doc.legacyEditor.speedRegions : []),
	];
	const beforeRegions = regions(document);
	const afterRegions = regions(candidate);
	const visible = resolveVisibleClips(candidate);
	return {
		candidate,
		result: {
			clipId,
			assetId,
			sourceStartSec,
			sourceEndSec,
			sourceStartReset: sourceStartSec !== clip.sourceStartSec,
			keptTrims,
			droppedTrims,
			droppedRegions: beforeRegions
				.filter((r) => !afterRegions.some((a) => a.id === r.id))
				.map((r) => r.id),
			changedRegions: afterRegions
				.filter((r) =>
					beforeRegions.some((b) => b.id === r.id && JSON.stringify(b) !== JSON.stringify(r)),
				)
				.map((r) => r.id),
			orphanedOverlays: [...candidate.annotations, ...(candidate.videoOverlays ?? [])]
				.filter(
					(r) => r.anchor?.kind === "words" && !resolveOverlaySpan(candidate, visible, r.anchor),
				)
				.map((r) => r.id),
		},
	};
}

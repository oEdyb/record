import { resolveOverlaySpan } from "../timeline/overlayAnchors";
import { isSubframeSpan } from "./frameSpan";
import { type CheckRule, finding } from "./types";
export const overlayOrphaned: CheckRule = {
	id: "overlay.orphaned",
	severity: "warning",
	describe: "Overlay words are missing, its span is beyond the edit, or no kept footage remains.",
	fix: "removeAnnotation or removeVideoOverlay removes the orphaned overlay.",
	run(context) {
		const overlays = [
			...context.document.annotations
				.filter((region) => region.annotationSource !== "auto-caption")
				.map((region) => ({
					region,
					type: "removeAnnotation" as const,
				})),
			...(context.document.videoOverlays ?? []).map((region) => ({
				region,
				type: "removeVideoOverlay" as const,
			})),
		];
		return {
			findings: overlays.flatMap(({ region, type }) => {
				const span = region.anchor
					? resolveOverlaySpan(context.document, context.visible, region.anchor)
					: null;
				const authored = context.authored.find((a) => a.id === region.id);
				if (!region.anchor && authored && isSubframeSpan(authored.raw)) return [];
				const pieces = authored?.pieces ?? [];
				const orphaned = region.anchor
					? !span || span.fromSec >= context.durationSec || span.toSec > context.durationSec + 0.001
					: pieces.length === 0;
				if (!orphaned) return [];
				const at = Math.min(
					context.durationSec,
					span?.fromSec ?? context.authored.find((a) => a.id === region.id)?.at ?? 0,
				);
				return [
					finding(
						this,
						{
							startSec: at,
							endSec: Math.max(at, Math.min(context.durationSec, span?.toSec ?? at)),
						},
						region.anchor?.kind === "words" ? region.anchor.clipId : (region.clipId ?? null),
						`Overlay ${region.id} has missing anchor words or no complete span in the edit.`,
						[
							type === "removeAnnotation"
								? { type, args: { annotationId: region.id } }
								: { type, args: { videoOverlayId: region.id } },
						],
					),
				];
			}),
		};
	},
};

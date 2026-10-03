import { z } from "zod";
import { pickOutputDims } from "../../src/lib/ai-edition/document/outputFormat";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";

export const brollSwapFields = z.strictObject({
	videoOverlayId: z.string().min(1),
	assetId: z.string().min(1),
	sourceOffsetSec: z.number().finite().nonnegative().default(0),
	fit: z.enum(["auto", "cover", "contain"]).default("auto"),
	time: z.enum(["trim", "hold"]).default("trim"),
});

export function inspectBrollSwap(document: AxcutDocument, input: z.infer<typeof brollSwapFields>) {
	const overlay = document.videoOverlays?.find((o) => o.id === input.videoOverlayId);
	if (!overlay) throw new Error("UNKNOWN_VIDEO_OVERLAY");
	const asset = document.assets.find((a) => a.id === input.assetId);
	if (!asset || asset.durationSec === undefined || !Number.isFinite(asset.durationSec))
		throw new Error("MEDIA_UNAVAILABLE: Replacement duration could not be read.");
	const availableSec = asset.durationSec - input.sourceOffsetSec;
	if (availableSec <= 0.5)
		throw new Error("MEDIA_TOO_SHORT: More than 0.5 seconds must remain after the offset.");
	if (!asset.video?.width || !asset.video.height)
		throw new Error("MEDIA_UNAVAILABLE: Replacement video dimensions could not be read.");
	const settings = getEditorSettings(document);
	const canvas = pickOutputDims(document, settings.aspectRatio, {}, settings.outputResolution);
	const slotAspect =
		(canvas.width * (overlay.placement?.width ?? 100)) /
		(canvas.height * (overlay.placement?.height ?? 100));
	const mediaAspect = asset.video.width / asset.video.height;
	const matches = Math.abs(mediaAspect / slotAspect - 1) <= 0.08 + 1e-9;
	const chosen = input.fit === "auto" ? (matches ? "cover" : "contain") : input.fit;
	const fit = {
		chosen,
		slotAspect,
		mediaAspect,
		reason:
			input.fit !== "auto"
				? `Forced ${input.fit}.`
				: matches
					? "Aspect ratios agree within 8%."
					: "Aspect ratios differ by more than 8%; contain preserves the complete image.",
	};
	const spanSec = (overlay.endMs - overlay.startMs) / 1000;
	const shortenedBySec = input.time === "trim" ? Math.max(0, spanSec - availableSec) : 0;
	const unusedTailSec = Math.max(0, availableSec - spanSec);
	if (shortenedBySec > 0 && overlay.anchor)
		throw new Error(
			"INVALID_INPUT: Shortening anchored overlays is not supported yet; use --time hold.",
		);
	const notes: string[] = [];
	if (shortenedBySec > 0)
		notes.push(`Shortened overlay by ${shortenedBySec}s to fit the available media.`);
	if (input.time === "hold" && availableSec < spanSec)
		notes.push(`Holds the last frame for ${spanSec - availableSec}s; media speed is unchanged.`);
	return {
		overlay,
		asset,
		report: {
			overlayId: overlay.id,
			previousAssetId: overlay.assetId,
			assetId: asset.id,
			fit,
			time: {
				spanSec,
				availableSec,
				...(shortenedBySec > 0 ? { shortenedBySec } : {}),
				...(unusedTailSec > 0 ? { unusedTailSec } : {}),
			},
			notes,
		},
	};
}

export function swapVideoOverlay(document: AxcutDocument, input: z.infer<typeof brollSwapFields>) {
	const { overlay, report } = inspectBrollSwap(document, input);
	const shortened = report.time.shortenedBySec !== undefined;
	const endMs = shortened
		? overlay.startMs + Math.floor(report.time.availableSec * 1000)
		: overlay.endMs;
	const replacement = {
		...overlay,
		assetId: input.assetId,
		sourceOffsetSec: input.sourceOffsetSec,
		fit: report.fit.chosen,
		endMs,
		...(shortened && overlay.sourceStartSec !== undefined
			? { sourceEndSec: overlay.sourceStartSec + (endMs - overlay.startMs) / 1000 }
			: {}),
	};
	return {
		candidate: documentSchema.parse({
			...document,
			videoOverlays: document.videoOverlays?.map((o) => (o.id === overlay.id ? replacement : o)),
		}),
		result: report,
	};
}

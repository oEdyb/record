import { z } from "zod";
import {
	buildSceneDescription,
	projectVideoOverlays,
	resolveVisibleClips,
} from "@/native/sceneDescription";
import {
	captionCuesToTextRegions,
	deriveCaptionCues,
	getCaptionSettings,
	getCaptionTranslations,
} from "../captions";
import type { AxcutDocument } from "../schema";
import { resolveOverlayInputs } from "../timeline/overlayAnchors";
import { buildTimelinePlaybackProjection, projectRegionsToSource } from "../timeline/timelineMap";

export interface EditSpan {
	start: number;
	end: number;
}

export interface EditClip {
	id: string;
	name: string;
	assetId: string;
}

const regionMetadata = z.object({
	id: z.string(),
	startMs: z.number(),
	endMs: z.number(),
	clipId: z.string().optional(),
	sourceStartSec: z.number().optional(),
	sourceEndSec: z.number().optional(),
	source: z.enum(["manual", "auto"]).optional(),
	mode: z.enum(["fullscreen", "emphasis"]).optional(),
});

export type RegionKind = "camera" | "zoom" | "annotation" | "video-overlay" | "caption";
export type AuthoredRegion = z.infer<typeof regionMetadata> & { kind: RegionKind; name: string };

export interface EditRegion {
	id: string;
	name: string;
	kind: RegionKind;
	source: "manual" | "auto";
	layer: "project";
	fragment: number;
	clip: EditClip;
	span: EditSpan;
	raw: EditSpan;
	media: EditSpan;
	values: Record<string, unknown>;
}

export function resolveEdit(document: AxcutDocument) {
	const visible = resolveVisibleClips(document);
	const scene = buildSceneDescription(document);
	const projection = buildTimelinePlaybackProjection(visible, document.timeline.clips);
	const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
	const fragments = projection.map((part, index) => ({
		index,
		clip: {
			id: part.rawClipId,
			name: assets.get(part.segment.assetId)?.label ?? part.rawClipId,
			assetId: part.segment.assetId,
		},
		edited: { start: part.playbackStartSec, end: part.playbackEndSec },
		raw: { start: part.rawStartSec, end: part.rawEndSec },
		source: {
			start: part.segment.sourceStartSec,
			end: part.segment.sourceEndSec ?? part.segment.sourceStartSec,
		},
		regions: [] as EditRegion[],
	}));
	const settings = getCaptionSettings(document);
	const captions = captionCuesToTextRegions(
		deriveCaptionCues(document, settings, getCaptionTranslations(document)),
		settings,
	);
	const camera = z
		.array(regionMetadata)
		.parse(document.legacyEditor?.cameraFullscreenRegions ?? []);
	const authored: AuthoredRegion[] = [];
	const regions: EditRegion[] = [];
	const authoredPieces: EditRegion[] = [];
	const add = <
		T extends {
			id: string;
			startMs: number;
			endMs: number;
			anchor?: import("../schema/overlayAnchor").OverlayAnchor;
		},
	>(
		inputs: T[],
		kind: RegionKind,
		outputs: { startSec: number; endSec: number; clipIndex?: number }[],
		name: (region: T) => string,
		sort?: (a: T, b: T) => number,
	) => {
		const tagged = inputs.map((input) => ({
			...input,
			originId: input.id,
			metadata: {
				...regionMetadata.parse(input),
				kind,
				name: name(input),
				source: kind === "caption" ? ("auto" as const) : regionMetadata.parse(input).source,
			},
		}));
		authored.push(...tagged.map((input) => input.metadata));
		const pieces = projectRegionsToSource(
			resolveOverlayInputs(document, visible, tagged),
			visible,
			document.timeline.clips,
			() => "piece",
		);
		if (sort) pieces.sort(sort);
		pieces.forEach((piece, index) => {
			const fragment = piece.clipIndex === undefined ? undefined : fragments[piece.clipIndex];
			if (!fragment) return;
			const output = outputs[index];
			const make = (start: number, end: number, values: Record<string, unknown>): EditRegion => ({
				id: piece.originId,
				name: piece.metadata.name,
				kind,
				source: piece.metadata.source ?? "manual",
				layer: "project",
				fragment: fragment.index,
				clip: fragment.clip,
				span: {
					start: fragment.edited.start + start - fragment.source.start,
					end: fragment.edited.start + end - fragment.source.start,
				},
				raw: {
					start: fragment.raw.start + start - fragment.source.start,
					end: fragment.raw.start + end - fragment.source.start,
				},
				media: { start, end },
				values,
			});
			authoredPieces.push(make(piece.startMs / 1000, piece.endMs / 1000, {}));
			if (!output) return;
			const values = { ...output, id: piece.originId };
			const resolved = make(
				piece.anchor ? Math.max(output.startSec, piece.startMs / 1000) : output.startSec,
				output.endSec,
				values,
			);
			regions.push(resolved);
			fragment.regions.push(resolved);
		});
	};
	add(camera, "camera", scene.cameraFullscreenRegions, (region) =>
		region.mode === "emphasis" ? "Camera emphasis" : "Full camera",
	);
	add(document.zoomRanges, "zoom", scene.zoomRegions, () => "Zoom");
	const annotationInputs = [...document.annotations, ...captions];
	const annotationOutputs = [...scene.annotations];
	const sortedAnnotations = projectRegionsToSource(
		resolveOverlayInputs(document, visible, annotationInputs).map((region) => ({
			...region,
			originId: region.id,
		})),
		visible,
		document.timeline.clips,
		() => "piece",
	).sort((a, b) => a.zIndex - b.zIndex);
	for (const kind of ["annotation", "caption"] as const) {
		const isCaption = (id: string) => captions.some((caption) => caption.id === id);
		add(
			annotationInputs.filter((region) => isCaption(region.id) === (kind === "caption")),
			kind,
			annotationOutputs.filter(
				(_, index) => isCaption(sortedAnnotations[index]?.originId ?? "") === (kind === "caption"),
			),
			(region) => region.content || region.type,
			(a, b) => a.zIndex - b.zIndex,
		);
	}
	add(
		(document.videoOverlays ?? []).filter((region) => assets.get(region.assetId)?.originalPath),
		"video-overlay",
		projectVideoOverlays(document, visible, false),
		(region) => assets.get(region.assetId)?.label ?? "Video overlay",
	);
	return {
		document,
		visible,
		scene,
		projection,
		fragments,
		regions,
		authored,
		authoredPieces,
		assets,
		duration: fragments.at(-1)?.edited.end ?? 0,
		cuts: fragments.slice(1).map((fragment) => fragment.edited.start),
	};
}

export type ResolvedEdit = ReturnType<typeof resolveEdit>;

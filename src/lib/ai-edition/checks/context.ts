import type { CameraFullscreenRegion } from "@/components/video-editor/types";
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
import type { AxcutDocument, AxcutWord } from "../schema";
import type { OverlayAnchor } from "../schema/overlayAnchor";
import { getEditorSettings } from "../store/editorSettings";
import { resolveOverlayInputs, resolveOverlaySpan } from "../timeline/overlayAnchors";
import {
	anchoredToRawSpanSec,
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
	projectRegionsToSource,
	rawTimeToPlaybackTime,
} from "../timeline/timelineMap";
import { assetFiles } from "./assetFiles";

export interface Span {
	startSec: number;
	endSec: number;
}
export type RegionKind = "camera" | "zoom" | "annotation" | "video-overlay" | "caption";
export interface RegionSource {
	anchor?: OverlayAnchor;
	id: string;
	startMs: number;
	endMs: number;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
	source?: unknown;
	origin?: unknown;
	annotationSource?: string;
	automaticDirection?: unknown;
	mode?: string;
	zIndex?: number;
}
export interface ResolvedRegion {
	id: string;
	name: string;
	kind: RegionKind;
	origin: "manual" | "auto";
	layer: "project";
	drawOrder: number;
	clipIndex: number;
	clip: string;
	edited: Span;
	raw: Span;
	source: Span;
	value: object;
}
export interface AuthoredRegion {
	origin: "manual" | "auto";
	captionSource?: { assetId: string; wordIds: string[]; clipIds: string[] };
	id: string;
	name: string;
	kind: RegionKind;
	clip: string | null;
	raw: Span;
	at: number;
	pieces: ResolvedRegion[];
}
export interface AudioObservation {
	microphonePeaks: Float32Array | null;
	quietSpans: Span[];
	speechProbabilities?: Float32Array | null;
	speechFrameSec?: number;
}
export interface CheckEvidence {
	audioAssets?: ReadonlySet<string>;
	audio?: ReadonlyMap<string, AudioObservation>;
	files?: Readonly<Record<string, boolean | null>>;
}

function isRegion(value: unknown): value is CameraFullscreenRegion & RegionSource {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"startMs" in value &&
		typeof value.startMs === "number" &&
		"endMs" in value &&
		typeof value.endMs === "number"
	);
}

export function buildResolvedEdit(document: AxcutDocument, evidence: CheckEvidence = {}) {
	const visible = resolveVisibleClips(document);
	const projection = buildTimelinePlaybackProjection(visible, document.timeline.clips);
	const scene = buildSceneDescription(document);
	const fragments = projection.map((part, clipIndex) => ({
		clipIndex,
		clip: part.rawClipId,
		assetId: part.segment.assetId,
		edited: { startSec: part.playbackStartSec, endSec: part.playbackEndSec },
		raw: { startSec: part.rawStartSec, endSec: part.rawEndSec },
		source: {
			startSec: part.segment.sourceStartSec,
			endSec: part.segment.sourceEndSec ?? part.segment.sourceStartSec,
		},
		regions: [] as ResolvedRegion[],
	}));
	const settings = getEditorSettings(document);
	const captions = getCaptionSettings(document);
	const captionCues = deriveCaptionCues(document, captions, getCaptionTranslations(document));
	const captionRegions = captionCuesToTextRegions(captionCues, captions);
	const cameraValues: unknown = document.legacyEditor?.cameraFullscreenRegions;
	const cameras = Array.isArray(cameraValues) ? cameraValues.filter(isRegion) : [];
	const authored: AuthoredRegion[] = [];
	const regions: ResolvedRegion[] = [];
	const add = (
		sources: RegionSource[],
		kind: RegionKind,
		rendered: { startSec: number; endSec: number; clipIndex?: number }[],
	) => {
		const projected = resolveOverlayInputs(document, visible, sources)
			.flatMap((source) =>
				projectRegionsToSource([source], visible, document.timeline.clips, () => source.id),
			)
			.filter((piece) => kind !== "video-overlay" || piece.clipIndex !== undefined);
		if (kind === "annotation") projected.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
		for (const source of sources) {
			const anchorSpan = source.anchor
				? resolveOverlaySpan(document, visible, source.anchor)
				: null;
			const raw = anchorSpan
				? {
						startSec: playbackTimeToRawTime(anchorSpan.fromSec, projection),
						endSec: playbackTimeToRawTime(anchorSpan.toSec, projection, "before"),
					}
				: source.clipId !== undefined &&
						source.sourceStartSec !== undefined &&
						source.sourceEndSec !== undefined
					? anchoredToRawSpanSec(
							{
								clipId: source.clipId,
								sourceStartSec: source.sourceStartSec,
								sourceEndSec: source.sourceEndSec,
							},
							document.timeline.clips,
						)
					: { startSec: source.startMs / 1000, endSec: source.endMs / 1000 };
			if (!raw) continue;
			const name =
				kind === "camera" ? (source.mode === "emphasis" ? "Camera emphasis" : "Full camera") : kind;
			const owner: AuthoredRegion = {
				id: source.id,
				origin:
					source.source === "auto" ||
					source.origin === "auto" ||
					source.automaticDirection ||
					source.annotationSource === "auto-caption"
						? "auto"
						: "manual",
				name,
				kind,
				raw,
				clip: source.clipId ?? null,
				at: rawTimeToPlaybackTime(raw.startSec, projection),
				pieces: [],
			};
			authored.push(owner);
			projected.forEach((piece, index) => {
				if (piece.id !== source.id || piece.clipIndex === undefined) return;
				const fragment = fragments[piece.clipIndex];
				if (!fragment) return;
				const value = rendered[index];
				const span = { startSec: piece.startMs / 1000, endSec: piece.endMs / 1000 };
				const resolve = (span: Span, value: object): ResolvedRegion => ({
					id: source.id,
					name,
					kind,
					layer: "project",
					// Native B-roll is a separate pass below all annotations, regardless of zIndex.
					drawOrder: kind === "annotation" ? index + 1 : 0,
					clip: fragment.clip,
					clipIndex: piece.clipIndex ?? 0,
					origin:
						source.source === "auto" ||
						source.origin === "auto" ||
						source.automaticDirection ||
						source.annotationSource === "auto-caption" ||
						kind === "caption"
							? "auto"
							: "manual",
					source: span,
					edited: {
						startSec: fragment.edited.startSec + span.startSec - fragment.source.startSec,
						endSec: fragment.edited.startSec + span.endSec - fragment.source.startSec,
					},
					raw: {
						startSec: fragment.raw.startSec + span.startSec - fragment.source.startSec,
						endSec: fragment.raw.startSec + span.endSec - fragment.source.startSec,
					},
					value: { ...value, id: source.id, ...(source.anchor ? { anchor: source.anchor } : {}) },
				});
				owner.pieces.push(resolve(span, value ?? piece));
				if (value) {
					const effective = resolve(
						{
							startSec: source.anchor ? Math.max(value.startSec, span.startSec) : value.startSec,
							endSec: value.endSec,
						},
						value,
					);
					regions.push(effective);
					fragment.regions.push(effective);
				}
			});
		}
	};
	add(cameras, "camera", scene.cameraFullscreenRegions);
	add(document.zoomRanges ?? [], "zoom", scene.zoomRegions);
	const annotationSources: RegionSource[] = [...(document.annotations ?? []), ...captionRegions];
	add(annotationSources, "annotation", scene.annotations);
	const captionIds = new Set(
		[
			...captionRegions,
			...document.annotations.filter((region) => region.annotationSource === "auto-caption"),
		].map((region) => region.id),
	);
	for (const region of [...regions, ...authored.flatMap((item) => item.pieces)]) {
		if (captionIds.has(region.id)) {
			region.kind = "caption";
			region.name = "Caption";
			region.origin = "auto";
		}
	}
	for (const region of authored) {
		const cue = captionCues.find((cue) => cue.id === region.id);
		if (
			cue ||
			document.annotations?.some(
				(item) => item.id === region.id && item.annotationSource === "auto-caption",
			)
		) {
			region.kind = "caption";
			region.origin = "auto";
			if (cue?.source)
				region.captionSource = {
					...cue.source,
					clipIds: document.timeline.clips
						.filter(
							(clip) =>
								clip.assetId === cue.source?.assetId &&
								clip.timelineStartSec < region.raw.endSec &&
								clip.timelineEndSec > region.raw.startSec,
						)
						.map((clip) => clip.id),
				};
		}
	}
	// Missing overlay assets are omitted by the scene builder, so pair only renderable overlays.
	const overlays = document.videoOverlays ?? [];
	const renderable = overlays.filter((overlay) =>
		document.assets.some((asset) => asset.id === overlay.assetId && asset.originalPath),
	);
	add(renderable, "video-overlay", projectVideoOverlays(document, visible, false));
	add(
		overlays.filter((overlay) => !renderable.includes(overlay)),
		"video-overlay",
		[],
	);
	const words = new Map<string, AxcutWord[]>();
	for (const asset of document.assets)
		words.set(
			asset.id,
			(
				document.transcripts.find((item) => item.assetId === asset.id) ??
				(document.transcript?.assetId === asset.id ? document.transcript : null)
			)?.words ?? [],
		);
	return {
		document,
		scene,
		settings,
		visible,
		projection,
		fragments,
		regions,
		authored,
		words,
		assets: document.assets,
		assetFiles: assetFiles(document),
		audioAssets: evidence.audioAssets,
		audio: evidence.audio ?? new Map<string, AudioObservation>(),
		files: evidence.files ?? {},
		durationSec: fragments.at(-1)?.edited.endSec ?? 0,
		cuts: fragments
			.slice(1)
			.map((right, index) => ({ at: right.edited.startSec, left: fragments[index], right })),
	};
}
export type ResolvedEdit = ReturnType<typeof buildResolvedEdit>;

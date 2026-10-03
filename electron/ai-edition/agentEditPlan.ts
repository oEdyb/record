import { z } from "zod";
import {
	agentAutomaticSettingsSchema,
	resolveAgentAutomaticSettings,
} from "../../src/lib/ai-edition/agent/automaticSettings";
import {
	getCaptionSettings,
	patchCaptionSettings,
} from "../../src/lib/ai-edition/captions/settings";
import { createId } from "../../src/lib/ai-edition/document/ids";
import { splitClipAt } from "../../src/lib/ai-edition/document/timeline";
import { clipLayoutOverrideSchema } from "../../src/lib/ai-edition/layout/schema";
import {
	assertClipLayoutSupported,
	resolveClipEditorSettings,
	sizePercent,
} from "../../src/lib/ai-edition/layout/vocabulary";
import {
	type AxcutDocument,
	annotationRegionSchema,
	documentSchema,
	zoomRegionSchema,
} from "../../src/lib/ai-edition/schema";
import { audioClipSchema } from "../../src/lib/ai-edition/schema/audioOverlays";
import type { OverlayAnchor } from "../../src/lib/ai-edition/schema/overlayAnchor";
import { overlayAnchorSchema } from "../../src/lib/ai-edition/schema/overlayAnchor";
import {
	getEditorSettings,
	patchEditorSettings,
} from "../../src/lib/ai-edition/store/editorSettings";
import type { RecordedDirectionObservation } from "../../src/lib/ai-edition/timeline/automatic-direction";
import { writeAutomaticDirectionSettings } from "../../src/lib/ai-edition/timeline/automatic-direction-settings";
import { resolveOverlaySpan } from "../../src/lib/ai-edition/timeline/overlayAnchors";
import {
	anchorRegionsWithDerivedMs,
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
	rawTimeToPlaybackTime,
} from "../../src/lib/ai-edition/timeline/timelineMap";
import {
	effectiveZoomScale,
	MAX_ZOOM_SCALE,
	MIN_ZOOM_SCALE,
} from "../../src/lib/ai-edition/timeline/zoom-scale";
import { screenFramingVariantKey, setScreenFramingForVariant } from "../../src/lib/screenFraming";
import { resolveVisibleClips } from "../../src/native/sceneDescription";
import {
	addAnnotationArgs,
	addCameraFullscreenArgs,
	addTrimArgs,
	addZoomArgs,
	executeAgentTool,
	moveClipArgs,
	removeClipArgs,
	removeModifierArgs,
	removeTrimArgs,
	setAnnotationArgs,
	setCameraFullscreenArgs,
	setClipRangeArgs,
	setTrimArgs,
	setZoomArgs,
} from "./agent-tools";
import { applyAgentAutomaticDirection } from "./agentAutomaticDirection";
import { brollSwapFields, swapVideoOverlay } from "./agentBrollSwap";
import { replaceClipSource } from "./agentClipReplacement";
import { agentEditorSettingsSchema } from "./agentEditorSettings";

export { agentEditorSettingsSchema, agentLayoutSettingsSchema } from "./agentEditorSettings";

const percent = z.number().min(0).max(100);
const position = z.strictObject({ cx: z.number().min(0).max(1), cy: z.number().min(0).max(1) });
const zoomPresentation = {
	motionStyle: zoomRegionSchema.shape.motionStyle,
	motionSpeed: zoomRegionSchema.shape.motionSpeed,
	customScale: z.number().finite().min(MIN_ZOOM_SCALE).max(MAX_ZOOM_SCALE).optional(),
};
const annotationPresentation = {
	anchor: overlayAnchorSchema.optional(),
	motion: z.enum(["fade", "rise", "cut", "instant"]).optional(),
	style: annotationRegionSchema.shape.style
		.partial()
		.extend({
			fontSize: z.number().min(1).max(512).optional(),
			fontFamily: z.string().min(1).max(128).optional(),
			color: z.string().max(256).optional(),
			backgroundColor: z.string().max(256).optional(),
			lastBackgroundColor: z.string().max(256).optional(),
		})
		.strict()
		.optional(),
	imageDataUrl: z
		.string()
		.max(2 * 1024 * 1024)
		.regex(
			/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
			"Expected an inline PNG, JPEG or WebP; URLs and SVG are not supported.",
		)
		.optional(),
	position: z.strictObject({ x: percent, y: percent }).optional(),
	size: z.strictObject({ width: percent.positive(), height: percent.positive() }).optional(),
};
const audioFields = audioClipSchema.shape;
const audioInput = z.strictObject({
	assetId: audioFields.assetId,
	startSec: audioFields.startSec,
	endSec: audioFields.endSec,
	sourceOffsetSec: audioFields.sourceOffsetSec.default(0),
	gain: audioFields.gain.default(1),
	fadeInSec: audioFields.fadeInSec.default(0),
	fadeOutSec: audioFields.fadeOutSec.default(0),
});
const overlayPlacement = z
	.strictObject({
		x: percent,
		y: percent,
		width: percent.positive(),
		height: percent.positive(),
	})
	.nullable();
const videoOverlayPatch = z.strictObject({
	anchor: overlayAnchorSchema.optional(),
	motion: z.enum(["fade", "cut"]).optional(),
	assetId: z.string().min(1),
	startSec: z.number().finite().nonnegative(),
	endSec: z.number().finite().nonnegative(),
	sourceOffsetSec: z.number().finite().nonnegative(),
	fit: z.enum(["cover", "contain"]),
	placement: overlayPlacement,
	opacity: z.number().finite().min(0).max(1),
});
const videoOverlayFields = videoOverlayPatch.extend({
	sourceOffsetSec: videoOverlayPatch.shape.sourceOffsetSec.default(0),
	fit: videoOverlayPatch.shape.fit.default("cover"),
	placement: overlayPlacement.default(null),
	opacity: videoOverlayPatch.shape.opacity.default(1),
});

export const agentEditOperationSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("swapVideoOverlay"), args: brollSwapFields }),
	z.strictObject({
		type: z.literal("replaceClipSource"),
		args: z.strictObject({ clipId: z.string().min(1), assetId: z.string().min(1) }),
	}),
	z.strictObject({ type: z.literal("addVideoOverlay"), args: videoOverlayFields }),
	z.strictObject({
		type: z.literal("removeAnnotation"),
		args: z.strictObject({ annotationId: z.string().min(1) }),
	}),
	z.strictObject({
		type: z.literal("setVideoOverlay"),
		args: videoOverlayPatch
			.partial()
			.extend({ videoOverlayId: z.string().min(1) })
			.strict(),
	}),
	z.strictObject({
		type: z.literal("removeVideoOverlay"),
		args: z.strictObject({ videoOverlayId: z.string().min(1) }),
	}),
	z.strictObject({ type: z.literal("addAudioClip"), args: audioInput }),
	z.strictObject({
		type: z.literal("setAudioClip"),
		args: z
			.strictObject({ ...audioFields })
			.omit({ id: true })
			.partial()
			.extend({ audioClipId: audioFields.id })
			.strict(),
	}),
	z.strictObject({
		type: z.literal("removeAudioClip"),
		args: z.strictObject({ audioClipId: audioFields.id }),
	}),
	z.strictObject({ type: z.literal("set-layout"), settings: agentEditorSettingsSchema }),
	z.strictObject({
		type: z.literal("setAutomaticDirectionSettings"),
		settings: agentAutomaticSettingsSchema,
	}),
	z.strictObject({
		type: z.literal("autoDirectionRun"),
		settings: agentAutomaticSettingsSchema.optional(),
	}),
	z.strictObject({ type: z.literal("autoDirectionRemove") }),
	z.strictObject({
		type: z.literal("autoDirectionRegenerate"),
		settings: agentAutomaticSettingsSchema.optional(),
	}),
	z.strictObject({
		type: z.literal("setClipLayout"),
		clipId: z.string().min(1),
		layout: clipLayoutOverrideSchema.nullable(),
	}),
	z.strictObject({
		type: z.literal("addZoom"),
		args: addZoomArgs
			.extend({ focus: position.default({ cx: 0.5, cy: 0.5 }), ...zoomPresentation })
			.strict(),
	}),
	z.strictObject({
		type: z.literal("setZoom"),
		args: setZoomArgs.extend({ focus: position.optional(), ...zoomPresentation }).strict(),
	}),
	z.strictObject({
		type: z.literal("addAnnotation"),
		args: addAnnotationArgs.extend(annotationPresentation).strict(),
	}),
	z.strictObject({
		type: z.literal("setAnnotation"),
		args: setAnnotationArgs.extend(annotationPresentation).strict(),
	}),
	z.strictObject({
		type: z.literal("addCameraFullscreen"),
		args: addCameraFullscreenArgs.strict(),
	}),
	z.strictObject({
		type: z.literal("setCameraFullscreen"),
		args: setCameraFullscreenArgs.strict(),
	}),
	z.strictObject({
		type: z.literal("addTrim"),
		args: addTrimArgs.extend({ clipId: z.string().min(1) }).strict(),
	}),
	z.strictObject({ type: z.literal("setTrim"), args: setTrimArgs.strict() }),
	z.strictObject({ type: z.literal("setClipRange"), args: setClipRangeArgs.strict() }),
	z.strictObject({ type: z.literal("moveClip"), args: moveClipArgs.strict() }),
	z.strictObject({ type: z.literal("removeClip"), args: removeClipArgs.strict() }),
	z.strictObject({ type: z.literal("removeTrim"), args: removeTrimArgs.strict() }),
	z.strictObject({
		type: z.literal("removeTrims"),
		args: z.strictObject({ trimRangeIds: z.array(z.string().min(1)).min(1).max(500) }),
	}),
	z.strictObject({ type: z.literal("removeModifier"), args: removeModifierArgs.strict() }),
	z.strictObject({
		type: z.literal("splitClip"),
		args: z.strictObject({
			clipId: z.string().min(1),
			sourceTimeSec: z.number().finite().nonnegative(),
		}),
	}),
]);
export const agentEditBatchSchema = z.array(agentEditOperationSchema).min(1).max(500);
export type AgentEditOperation = z.infer<typeof agentEditOperationSchema>;
export const AGENT_EDIT_OPERATION_TYPES = agentEditOperationSchema.options.map(
	(option) => option.shape.type.value,
);

function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) freeze(nested);
		Object.freeze(value);
	}
	return value;
}

function rows(document: AxcutDocument) {
	const found = new Map<string, string>();
	const collections: unknown[] = [
		document.assets,
		document.audioAssets,
		document.timeline.audioClips,
		document.timeline.clips,
		document.timeline.trimRanges,
		document.zoomRanges,
		document.annotations,
		document.videoOverlays,
		document.legacyEditor?.cameraFullscreenRegions,
		document.legacyEditor?.speedRegions,
	];
	for (const collection of collections) {
		if (!Array.isArray(collection)) continue;
		for (const row of collection) {
			if (row && typeof row === "object" && "id" in row && typeof row.id === "string")
				found.set(row.id, (found.get(row.id) ?? "") + JSON.stringify(row));
		}
	}
	return found;
}

function checkRange(document: AxcutDocument, operation: AgentEditOperation) {
	if (
		!("args" in operation) ||
		operation.type === "addAudioClip" ||
		operation.type === "setAudioClip" ||
		operation.type === "removeAudioClip"
	)
		return;
	const args = operation.args;
	if (
		"startSec" in args &&
		"endSec" in args &&
		args.startSec !== undefined &&
		args.endSec !== undefined &&
		args.endSec <= args.startSec
	)
		throw new Error("INVALID_RANGE: endSec must exceed startSec.");
	if (
		operation.type === "setZoom" ||
		operation.type === "setAnnotation" ||
		operation.type === "setCameraFullscreen"
	) {
		const existing =
			operation.type === "setZoom"
				? document.zoomRanges.find((r) => r.id === operation.args.zoomId)
				: operation.type === "setAnnotation"
					? document.annotations.find((r) => r.id === operation.args.annotationId)
					: (
							document.legacyEditor?.cameraFullscreenRegions as
								| Array<{ id: string; startMs: number; endMs: number }>
								| undefined
						)?.find((r) => r.id === operation.args.cameraFullscreenId);
		if (
			existing &&
			!("anchor" in existing && existing.anchor) &&
			(operation.args.endSec ?? existing.endMs / 1000) <=
				(operation.args.startSec ?? existing.startMs / 1000)
		)
			throw new Error("INVALID_RANGE: Updated end must exceed start.");
	}
	if (operation.type === "setClipRange") {
		const clip = document.timeline.clips.find((c) => c.id === operation.args.clipId);
		const asset = document.assets.find((a) => a.id === clip?.assetId);
		if (
			!clip ||
			asset?.durationSec === undefined ||
			operation.args.sourceEndSec <= operation.args.sourceStartSec ||
			operation.args.sourceEndSec > asset.durationSec
		)
			throw new Error("INVALID_RANGE: Clip range needs known source duration and valid bounds.");
	}
	if (operation.type === "addTrim" || operation.type === "setTrim") {
		const trim =
			operation.type === "setTrim"
				? document.timeline.trimRanges.find((t) => t.id === operation.args.trimRangeId)
				: null;
		const clipId = operation.type === "addTrim" ? operation.args.clipId : trim?.clipId;
		const clip = document.timeline.clips.find((c) => c.id === clipId);
		if (
			!clip ||
			clip.sourceEndSec === undefined ||
			operation.args.startSec < clip.sourceStartSec ||
			operation.args.endSec > clip.sourceEndSec
		)
			throw new Error("INVALID_RANGE: Trim must fit an explicit clip's known source range.");
	}
}

type VideoOverlayOperation = Extract<
	AgentEditOperation,
	{ type: "addVideoOverlay" | "setVideoOverlay" | "removeVideoOverlay" }
>;

function overlaySourceBounds(document: AxcutDocument, assetId: string) {
	const asset = document.assets.find((a) => a.id === assetId);
	if (!asset) throw new Error("UNKNOWN_ASSET: Import the video first with import-plan.");
	return asset.durationSec ?? null;
}

function updatedOverlayTiming(
	document: AxcutDocument,
	existing: { startMs: number; endMs: number; anchor?: OverlayAnchor },
	patch: { startSec?: number; endSec?: number; anchor?: OverlayAnchor },
) {
	const visible = resolveVisibleClips(document);
	const projection = buildTimelinePlaybackProjection(visible, document.timeline.clips);
	const current = existing.anchor ? resolveOverlaySpan(document, visible, existing.anchor) : null;
	const startSec =
		patch.startSec ??
		(current ? playbackTimeToRawTime(current.fromSec, projection) : existing.startMs / 1000);
	const endSec =
		patch.endSec ??
		(current ? playbackTimeToRawTime(current.toSec, projection, "before") : existing.endMs / 1000);
	const anchor =
		patch.anchor ??
		(patch.startSec !== undefined || patch.endSec !== undefined
			? {
					kind: "edited" as const,
					fromSec: rawTimeToPlaybackTime(startSec, projection),
					toSec: rawTimeToPlaybackTime(endSec, projection),
				}
			: existing.anchor);
	if (endSec <= startSec) throw new Error("INVALID_RANGE: End must exceed start.");
	return { startSec, endSec, anchor };
}

function applyVideoOverlayOperation(
	candidate: AxcutDocument,
	operation: VideoOverlayOperation,
	report: (result: Record<string, unknown>) => void,
): AxcutDocument {
	if (operation.type === "removeVideoOverlay") {
		const id = operation.args.videoOverlayId;
		if (!(candidate.videoOverlays ?? []).some((o) => o.id === id))
			throw new Error("UNKNOWN_VIDEO_OVERLAY");
		report({ ids: [id] });
		return documentSchema.parse({
			...candidate,
			videoOverlays: (candidate.videoOverlays ?? []).filter((o) => o.id !== id),
		});
	}
	const existing =
		operation.type === "setVideoOverlay"
			? (candidate.videoOverlays ?? []).find((o) => o.id === operation.args.videoOverlayId)
			: undefined;
	if (operation.type === "setVideoOverlay" && !existing) throw new Error("UNKNOWN_VIDEO_OVERLAY");
	const { videoOverlayId: _id, ...patch } =
		operation.type === "setVideoOverlay"
			? operation.args
			: { videoOverlayId: "", ...operation.args };
	const timing = existing?.anchor ? updatedOverlayTiming(candidate, existing, patch) : {};
	const merged = {
		assetId: existing?.assetId,
		startSec: existing ? existing.startMs / 1000 : undefined,
		endSec: existing ? existing.endMs / 1000 : undefined,
		sourceOffsetSec: existing?.sourceOffsetSec,
		fit: existing?.fit,
		placement: existing?.placement ?? null,
		opacity: existing?.opacity,
		anchor: existing?.anchor,
		motion: existing?.motion,
		...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
		...timing,
	} as z.infer<typeof videoOverlayFields>;
	if (merged.endSec <= merged.startSec)
		throw new Error("INVALID_RANGE: endSec must exceed startSec.");
	const durationSec = overlaySourceBounds(candidate, merged.assetId);
	if (
		durationSec !== null &&
		merged.sourceOffsetSec +
			(merged.anchor?.kind === "edited"
				? merged.anchor.toSec - merged.anchor.fromSec
				: merged.endSec - merged.startSec) >
			durationSec + 0.001
	)
		throw new Error(
			"INVALID_RANGE: Overlay span exceeds the video's duration from sourceOffsetSec.",
		);
	const id = existing?.id ?? createId("vo");
	const region = {
		id,
		...(merged.anchor ? { anchor: merged.anchor } : {}),
		...(merged.motion ? { motion: merged.motion } : {}),
		startMs: Math.round(merged.startSec * 1000),
		endMs: Math.round(merged.endSec * 1000),
		assetId: merged.assetId,
		sourceOffsetSec: merged.sourceOffsetSec,
		fit: merged.fit,
		placement: merged.placement,
		opacity: merged.opacity,
	};
	const placed = anchorRegionsWithDerivedMs([region], candidate.timeline.clips, () =>
		createId("vo"),
	);
	if (
		!merged.anchor &&
		!placed.some((fragment) => "clipId" in fragment && typeof fragment.clipId === "string")
	)
		throw new Error("INVALID_RANGE: The overlay span covers no clip on the raw timeline.");
	const others = (candidate.videoOverlays ?? []).filter((o) => o.id !== id);
	report({
		ids: placed.map((fragment) => fragment.id),
		startSec: Math.min(...placed.map((f) => f.startMs)) / 1000,
		endSec: Math.max(...placed.map((f) => f.endMs)) / 1000,
		fragments: placed.length,
	});
	return documentSchema.parse({ ...candidate, videoOverlays: [...others, ...placed] });
}

function splitCandidateClip(
	candidate: AxcutDocument,
	args: { clipId: string; sourceTimeSec: number },
	report: (ids: string[]) => void,
): AxcutDocument {
	const clip = candidate.timeline.clips.find((c) => c.id === args.clipId);
	if (!clip || clip.sourceEndSec === undefined)
		throw new Error("UNKNOWN_CLIP: splitClip needs an existing clip with a known source range.");
	const sourceLength = clip.sourceEndSec - clip.sourceStartSec;
	if (args.sourceTimeSec <= clip.sourceStartSec || args.sourceTimeSec >= clip.sourceEndSec)
		throw new Error(
			"INVALID_RANGE: sourceTimeSec must fall strictly inside the clip's source range.",
		);
	const timelineTimeSec =
		clip.timelineStartSec +
		((args.sourceTimeSec - clip.sourceStartSec) / sourceLength) *
			(clip.timelineEndSec - clip.timelineStartSec);
	const next = splitClipAt(candidate, clip.id, timelineTimeSec);
	if (next === candidate)
		throw new Error("INVALID_RANGE: Split point is too close to a clip edge.");
	const created = next.timeline.clips
		.filter((c) => !candidate.timeline.clips.some((existing) => existing.id === c.id))
		.map((c) => c.id);
	report([clip.id, ...created]);
	return documentSchema.parse(next);
}

/** Private candidate only: no persistence or second invocation to regenerate IDs on apply. */
export function prepareAgentEditPlan(
	base: AxcutDocument,
	rawOperations: unknown,
	observations: ReadonlyMap<number, RecordedDirectionObservation[]> = new Map(),
) {
	const operations = agentEditBatchSchema.parse(rawOperations);
	let candidate = documentSchema.parse(structuredClone(base));
	const results: { type: string; result: unknown }[] = [];
	for (const [index, operation] of operations.entries()) {
		try {
			checkRange(candidate, operation);
			if (operation.type === "setAutomaticDirectionSettings") {
				candidate = writeAutomaticDirectionSettings(
					candidate,
					resolveAgentAutomaticSettings(candidate, operation.settings),
				);
				results.push({
					type: operation.type,
					result: { changed_fields: ["automaticDirectionSettings"] },
				});
				continue;
			}
			if (
				operation.type === "autoDirectionRun" ||
				operation.type === "autoDirectionRemove" ||
				operation.type === "autoDirectionRegenerate"
			) {
				const directed = applyAgentAutomaticDirection(
					candidate,
					operation,
					observations.get(index),
				);
				candidate = directed.candidate;
				results.push({ type: operation.type, result: { regions: directed.counts } });
				continue;
			}
			if (operation.type === "swapVideoOverlay") {
				const swap = swapVideoOverlay(candidate, operation.args);
				candidate = swap.candidate;
				results.push({ type: operation.type, result: swap.result });
				continue;
			}
			if (operation.type === "replaceClipSource") {
				const replacement = replaceClipSource(
					candidate,
					operation.args.clipId,
					operation.args.assetId,
				);
				candidate = replacement.candidate;
				results.push({ type: operation.type, result: replacement.result });
				continue;
			}
			if (operation.type === "removeAnnotation") {
				if (!candidate.annotations.some((a) => a.id === operation.args.annotationId))
					throw new Error("UNKNOWN_ANNOTATION");
				candidate = {
					...candidate,
					annotations: candidate.annotations.filter((a) => a.id !== operation.args.annotationId),
				};
				results.push({ type: operation.type, result: { ids: [operation.args.annotationId] } });
				continue;
			}
			if (operation.type === "setAnnotation") {
				const existing = candidate.annotations.find((a) => a.id === operation.args.annotationId);
				if (existing?.anchor) {
					const args = operation.args;
					const timing = updatedOverlayTiming(candidate, existing, args);
					const next = annotationRegionSchema.parse({
						...existing,
						anchor: timing.anchor,
						startMs: timing.startSec * 1000,
						endMs: timing.endSec * 1000,
						...(args.text !== undefined ? { content: args.text, textContent: args.text } : {}),
						...(args.imageDataUrl
							? { type: "image", content: args.imageDataUrl, imageContent: args.imageDataUrl }
							: {}),
						...(args.position ? { position: args.position } : {}),
						...(args.size ? { size: args.size } : {}),
						...(args.style ? { style: { ...existing.style, ...args.style } } : {}),
						...(args.motion
							? {
									...(args.motion ? { motion: args.motion } : {}),
									style: {
										...existing.style,
										...args.style,
										textAnimation:
											args.motion === "cut" || args.motion === "instant" ? "none" : args.motion,
									},
								}
							: {}),
					});
					candidate = {
						...candidate,
						annotations: candidate.annotations.map((a) => (a.id === existing.id ? next : a)),
					};
					results.push({ type: operation.type, result: { ids: [existing.id] } });
					continue;
				}
			}
			if (operation.type === "addAnnotation" && operation.args.anchor) {
				const args = operation.args;
				const id = createId("ann");
				const region = annotationRegionSchema.parse({
					id,
					startMs: args.startSec * 1000,
					endMs: args.endSec * 1000,
					anchor: args.anchor,
					...(args.motion ? { motion: args.motion } : {}),
					type: args.imageDataUrl ? "image" : "text",
					content: args.imageDataUrl ?? args.text,
					position: args.position ?? { x: args.x, y: args.y },
					size: args.size ?? { width: 40, height: 15 },
					style: args.style ?? {},
					zIndex: Math.max(0, ...candidate.annotations.map((a) => a.zIndex)) + 1,
				});
				candidate = { ...candidate, annotations: [...candidate.annotations, region] };
				results.push({ type: operation.type, result: { ids: [id] } });
				continue;
			}
			if (operation.type === "setClipLayout") {
				if (!candidate.timeline.clips.some((clip) => clip.id === operation.clipId))
					throw new Error("UNKNOWN_CLIP");
				const clipLayouts = { ...candidate.clipLayouts };
				if (operation.layout === null) delete clipLayouts[operation.clipId];
				else
					clipLayouts[operation.clipId] = { ...clipLayouts[operation.clipId], ...operation.layout };
				candidate = { ...candidate, clipLayouts };
				results.push({
					type: operation.type,
					result: { clipId: operation.clipId, layout: clipLayouts[operation.clipId] ?? null },
				});
				continue;
			}
			if (operation.type === "set-layout") {
				const {
					screenFraming,
					cameraSize,
					captions,
					cursorShow,
					cursorTheme,
					cursor,
					...settings
				} = operation.settings;
				candidate = patchEditorSettings(candidate, {
					...settings,
					cursor: { ...cursor, show: cursorShow, theme: cursorTheme },
					...(cameraSize !== undefined ? { webcamSizePreset: sizePercent(cameraSize) } : {}),
				});
				if (settings.webcamPosition !== undefined && candidate.legacyEditor)
					delete candidate.legacyEditor.cameraAnchor;
				if (settings.cameraAnchor !== undefined)
					candidate = patchEditorSettings(candidate, {
						cameraAnchor: settings.cameraAnchor,
						webcamPosition: resolveClipEditorSettings(candidate).webcamPosition,
					});
				if (captions !== undefined) {
					const patch = typeof captions === "boolean" ? { enabled: captions } : captions;
					const merged = { ...getCaptionSettings(candidate), ...patch };
					if (merged.minWordsPerLine > merged.maxWordsPerLine)
						throw new Error("INVALID_CAPTION_WORD_RANGE");
					candidate = patchCaptionSettings(candidate, patch);
				}
				if (screenFraming) {
					const resolved = getEditorSettings(candidate);
					candidate = patchEditorSettings(candidate, {
						screenFramingByVariant: setScreenFramingForVariant(
							resolved.screenFramingByVariant,
							screenFramingVariantKey(resolved.aspectRatio, resolved.outputResolution),
							screenFraming,
						),
					});
				}
				results.push({
					type: operation.type,
					result: { changed_fields: Object.keys(operation.settings) },
				});
				continue;
			}
			if (
				operation.type === "addAudioClip" ||
				operation.type === "setAudioClip" ||
				operation.type === "removeAudioClip"
			) {
				const clips = candidate.timeline.audioClips ?? [];
				const clipId =
					operation.type === "addAudioClip" ? createId("audio") : operation.args.audioClipId;
				if (operation.type !== "addAudioClip" && !clips.some((clip) => clip.id === clipId))
					throw new Error("UNKNOWN_AUDIO_CLIP");
				let next = clips;
				if (operation.type === "addAudioClip")
					next = [...clips, audioClipSchema.parse({ ...operation.args, id: clipId })];
				else if (operation.type === "removeAudioClip")
					next = clips.filter((clip) => clip.id !== clipId);
				else {
					const { audioClipId: _id, ...patch } = operation.args;
					next = clips.map((clip) =>
						clip.id === clipId ? audioClipSchema.parse({ ...clip, ...patch }) : clip,
					);
				}
				candidate = documentSchema.parse({
					...candidate,
					timeline: { ...candidate.timeline, audioClips: next },
				});
				results.push({ type: operation.type, result: { ids: [clipId] } });
				continue;
			}

			if (
				operation.type === "addVideoOverlay" ||
				operation.type === "setVideoOverlay" ||
				operation.type === "removeVideoOverlay"
			) {
				candidate = applyVideoOverlayOperation(candidate, operation, (result) =>
					results.push({ type: operation.type, result }),
				);
				continue;
			}
			if (operation.type === "splitClip") {
				candidate = splitCandidateClip(candidate, operation.args, (ids) =>
					results.push({ type: operation.type, result: { ids } }),
				);
				continue;
			}
			if (operation.type === "removeTrims") {
				const known = new Set(candidate.timeline.trimRanges.map((trim) => trim.id));
				const missing = operation.args.trimRangeIds.filter((id) => !known.has(id));
				if (missing.length > 0) throw new Error(`Unknown trim range: ${missing.join(", ")}`);
				const removed = new Set(operation.args.trimRangeIds);
				candidate = {
					...candidate,
					timeline: {
						...candidate.timeline,
						trimRanges: candidate.timeline.trimRanges.filter((trim) => !removed.has(trim.id)),
					},
				};
				results.push({ type: operation.type, result: { ids: [...removed] } });
				continue;
			}
			const before = candidate;
			const toolArgs =
				operation.type === "addTrim" && !operation.args.assetId
					? {
							...operation.args,
							assetId: candidate.timeline.clips.find((c) => c.id === operation.args.clipId)
								?.assetId,
						}
					: operation.args;
			const execution = executeAgentTool(candidate, operation.type, JSON.stringify(toolArgs));
			if (!execution.ok || !execution.document) throw new Error(execution.resultJson);
			const result: Record<string, unknown> = JSON.parse(execution.resultJson);
			if (result.clamped === true)
				throw new Error("INVALID_RANGE: Operation would be clamped; inspect valid bounds first.");
			candidate = execution.document;
			if (operation.type === "addZoom" || operation.type === "setZoom") {
				const ids = new Set(Array.isArray(result.ids) ? result.ids : []);
				const { motionStyle, motionSpeed, customScale } = operation.args;
				candidate = {
					...candidate,
					zoomRanges: candidate.zoomRanges.map((region) =>
						ids.has(region.id)
							? {
									...region,
									...(motionStyle !== undefined ? { motionStyle } : {}),
									...(motionSpeed !== undefined ? { motionSpeed } : {}),
									...(customScale !== undefined ? { customScale } : {}),
								}
							: region,
					),
				};
				const zoom = candidate.zoomRanges.find((region) => ids.has(region.id));
				if (zoom) result.renderedScale = effectiveZoomScale(zoom);
			}
			if (operation.type === "addAnnotation" || operation.type === "setAnnotation") {
				const ids = new Set(
					Array.isArray(result.ids)
						? result.ids.filter((id): id is string => typeof id === "string")
						: [],
				);
				if (operation.type === "addAnnotation" && ids.size === 0)
					for (const ann of candidate.annotations)
						if (!before.annotations.some((old) => old.id === ann.id)) ids.add(ann.id);
				const { imageDataUrl, position: annotationPosition, size, style } = operation.args;
				candidate = {
					...candidate,
					annotations: candidate.annotations.map((ann) => {
						if (!ids.has(ann.id)) return ann;
						// An image has no text payload. Omit the field instead of
						// assigning undefined: the in-memory IPC plan must remain JSON.
						const { textContent: _textContent, ...withoutText } = ann;
						return {
							...(imageDataUrl ? withoutText : ann),
							...(imageDataUrl
								? { type: "image" as const, imageContent: imageDataUrl, content: imageDataUrl }
								: {}),
							...(annotationPosition ? { position: annotationPosition } : {}),
							...(size ? { size } : {}),
							...(style ? { style: { ...ann.style, ...style } } : {}),
						};
					}),
				};
			}
			candidate = documentSchema.parse(candidate);
			results.push({ type: operation.type, result });
		} catch (error) {
			throw new Error(
				`OPERATION_FAILED at index ${index} (${operation.type}): ${error instanceof Error ? error.message : "Invalid operation"}`,
			);
		}
	}
	candidate = documentSchema.parse(candidate);
	for (const clip of candidate.timeline.clips) assertClipLayoutSupported(candidate, clip.id);
	const previous = rows(base);
	const next = rows(candidate);
	const changedIds = [...new Set([...previous.keys(), ...next.keys()])].filter(
		(id) => previous.get(id) !== next.get(id),
	);
	const settingsChanged =
		JSON.stringify(base.legacyEditor) !== JSON.stringify(candidate.legacyEditor) ||
		JSON.stringify(base.clipLayouts) !== JSON.stringify(candidate.clipLayouts);
	return freeze({
		candidate,
		operations,
		changed: JSON.stringify(base) !== JSON.stringify(candidate),
		changed_ids: changedIds.slice(0, 200),
		changed_count: changedIds.length,
		changed_ids_truncated: changedIds.length > 200,
		settings_changed: settingsChanged,
		results,
	});
}

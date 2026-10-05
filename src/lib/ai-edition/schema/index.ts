import { overlayAnchorSchema } from "./overlayAnchor";
// Vendored from @axcut/schema (https://github.com/EtienneLescot/axcut) —
// original file: packages/axcut-schema/src/index.ts. Modifications for
// OpenScreen's AI-edition merge (Phase 0, see technical-documentation/architecture/document-model.md):
//
//   1. axcutSchemaVersion bumped 2 -> 3.
//   2. clip.sourceEndSec made optional (duration is unknown until asset is probed).
//   3. documentSchema gains annotations[], zoomRanges[], legacyEditor envelopes
//      so OpenScreen's existing regions + appearance settings survive the merge.
//
// ponytail: this exists as the SSOT project model. Phase 0 only touches the
// shape — runtime ops, IPC, and exporter integration land in Phase 1+.

import { z } from "zod";
// Cycle-safe: `aspectRatioUtils` has no schema dependency, and `document/outputFormat`
// is downstream of schema. We import the leaf tokeniser directly so the v5→v6 upgrader
// can rewrite `"native"` without dragging in the whole output-format module.
// Relative, not `@/`: the Electron main bundle imports this module and
// vite-plugin-electron builds it without the root resolve.alias.
import { toAspectRatioToken } from "../../../utils/aspectRatioUtils";
import { isMotionSpeed, type MotionSpeed } from "../../zoomMath/motionCurve";
// Cycle-safe: `document/ids` only pulls `uuid`, and `timeline/timelineMap`'s
// transitive value-imports (region-ventilation, virtual-preview) import from this
// module TYPE-ONLY, so requiring them here never re-enters schema at runtime.
import { createId } from "../document/ids";
import { cameraAnchorSchema, clipLayoutOverrideSchema } from "../layout/schema";
import { anchorRegionsWithDerivedMs } from "../timeline/timelineMap";
import { audioAssetSchema, audioClipSchema, validateAudioReferences } from "./audioOverlays";
import {
	automaticDirectionDismissalsSchema,
	automaticDirectionProvenanceSchema,
} from "./automatic-direction-review";

//   4. v5 — modifiers (zoom / annotation / speed / cameraFullscreen) become
//      CLIP-ANCHORED fragments: `{clipId, sourceStartSec, sourceEndSec}` is the
//      source of truth, `startMs`/`endMs` stay as a derived cache for the
//      transition. See technical-documentation/architecture/timeline-model.md
//   5. v6 — `"native"` AspectRatio is retired OPPORTUNISTICALLY. The v5→v6
//      upgrader rewrites a stored `"native"` to a concrete `"W:H"` token from
//      the timeline's largest clip, but only when the source dimensions are
//      actually known; otherwise it leaves the sentinel, which keeps resolving
//      dynamically at runtime. See `upgradeV5DocumentToV6` for why guessing
//      would corrupt v1.7 imports.
//   6. v7 — trims join the v5 clip anchor: `AxcutTrimRange` gains `clipId`.
//      They were the last region kind still addressed by `assetId` alone, which
//      made them AMBIGUOUS the moment two clips drew from the same asset (a
//      duplicated clip): every reader either matched both clips or picked the
//      first. See `upgradeV6DocumentToV7`.
//   8. v8 — assets can carry an explicit, versioned Clean Voice recipe. The
//      derived stem and its processing status remain in the app-owned cache;
//      neither is project data. An absent recipe means Original, which keeps
//      every v7 project non-destructive and opt-in after migration.
//   9. v9 — transcript words/segments preserve captured source roles and each
//      source keeps reproducibility evidence. Legacy transcripts become
//      explicit `unknown-mixed` data; no speaker identity is guessed.
export const axcutSchemaVersion = 11;

// ponytail: every region schema shares the same monotonicity rule
// (end >= start) with the same error shape. Factor the refine so the
// five call sites stay declarative; the message + path stay tied to
// the field names (e.g. `endSec >= startSec`, `endMs >= startMs`).
const endGteStart = <T extends z.ZodObject<z.ZodRawShape>>(
	schema: T,
	endKey: keyof T["shape"] & string,
	startKey: keyof T["shape"] & string,
) =>
	schema.refine((data) => (data[endKey] as number) >= (data[startKey] as number), {
		message: `${endKey} must be greater than or equal to ${startKey}`,
		path: [endKey],
	});

const isoDateSchema = z.string().datetime({ offset: true });

const transcriptSourceRoleSchema = z.enum(["you", "system", "unknown-mixed"]);

const wordSchema = z
	.object({
		id: z.string().min(1),
		segmentId: z.string().min(1),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		text: z.string(),
		sourceRole: transcriptSourceRoleSchema.optional(),
		confidence: z.number().min(0).max(1).optional(),
	})
	.refine((data) => data.endSec >= data.startSec, {
		message: "endSec must be greater than or equal to startSec",
		path: ["endSec"],
	});

const transcriptSegmentSchema = z
	.object({
		id: z.string().min(1),
		kind: z.enum(["speech", "silence"]),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		text: z.string(),
		wordIds: z.array(z.string().min(1)).default([]),
		sourceRole: transcriptSourceRoleSchema.optional(),
	})
	.refine((data) => data.endSec >= data.startSec, {
		message: "endSec must be greater than or equal to startSec",
		path: ["endSec"],
	});

const transcriptSourceEvidenceSchema = z.object({
	sourceRole: transcriptSourceRoleSchema,
	trackLanguageCode: z.enum(["qac", "qab"]).nullable(),
	sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
	backend: z.enum([
		"parakeet-coreml",
		"whispercpp-metal",
		"whispercpp-vulkan",
		"whispercpp-cuda",
		"whispercpp-cpu",
	]),
	model: z.object({
		id: z.enum(["parakeet-v3", "whisper"]),
		revision: z.string().min(1),
		artifactSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
	}),
	language: z.object({
		requested: z.string().min(1),
		detected: z.string().min(1),
	}),
	extraction: z.object({
		version: z.literal(1),
		sampleRate: z.literal(16_000),
		channels: z.literal(1),
	}),
	alignment: z.object({
		version: z.literal(1),
		method: z.literal("recognizer-native-acoustic-snap"),
	}),
});

export const transcriptSchema = z
	.object({
		assetId: z.string().min(1),
		language: z.string().min(1),
		sourceDslPath: z.string().optional(),
		sourceJsonPath: z.string().optional(),
		segments: z.array(transcriptSegmentSchema).default([]),
		words: z.array(wordSchema).default([]),
		/** Verified is reproducible. Legacy-unverified is set only by the v8 migration. */
		evidenceStatus: z.enum(["verified", "legacy-unverified"]).optional(),
		sources: z.array(transcriptSourceEvidenceSchema).default([]),
	})
	.superRefine((transcript, context) => {
		if (!transcript.evidenceStatus) {
			context.addIssue({
				code: "custom",
				path: ["evidenceStatus"],
				message: "Transcript evidence status is required.",
			});
		}
		const evidenceRoles = new Set(transcript.sources.map((source) => source.sourceRole));
		if (evidenceRoles.size !== transcript.sources.length) {
			context.addIssue({
				code: "custom",
				path: ["sources"],
				message: "Transcript source roles must be unique.",
			});
		}
		if (transcript.evidenceStatus === "verified" && transcript.sources.length === 0) {
			context.addIssue({
				code: "custom",
				path: ["sources"],
				message: "A verified transcript requires source evidence.",
			});
		}
		if (transcript.evidenceStatus === "legacy-unverified" && transcript.sources.length > 0) {
			context.addIssue({
				code: "custom",
				path: ["sources"],
				message: "A legacy-unverified transcript cannot claim verified source evidence.",
			});
		}

		const segmentsById = new Map(transcript.segments.map((segment) => [segment.id, segment]));
		for (const [index, segment] of transcript.segments.entries()) {
			if (!segment.sourceRole) {
				context.addIssue({
					code: "custom",
					path: ["segments", index, "sourceRole"],
					message: "Transcript segment source role is required.",
				});
			} else if (
				transcript.evidenceStatus === "verified" &&
				!evidenceRoles.has(segment.sourceRole)
			) {
				context.addIssue({
					code: "custom",
					path: ["segments", index, "sourceRole"],
					message: "Transcript segment role has no source evidence.",
				});
			} else if (
				transcript.evidenceStatus === "legacy-unverified" &&
				segment.sourceRole !== "unknown-mixed"
			) {
				context.addIssue({
					code: "custom",
					path: ["segments", index, "sourceRole"],
					message: "Legacy transcript content must stay unknown-mixed.",
				});
			}
		}

		for (const [index, word] of transcript.words.entries()) {
			const segment = segmentsById.get(word.segmentId);
			if (!word.sourceRole) {
				context.addIssue({
					code: "custom",
					path: ["words", index, "sourceRole"],
					message: "Transcript word source role is required.",
				});
			} else if (segment?.sourceRole && word.sourceRole !== segment.sourceRole) {
				context.addIssue({
					code: "custom",
					path: ["words", index, "sourceRole"],
					message: "Transcript word role must match its segment role.",
				});
			} else if (transcript.evidenceStatus === "verified" && !evidenceRoles.has(word.sourceRole)) {
				context.addIssue({
					code: "custom",
					path: ["words", index, "sourceRole"],
					message: "Transcript word role has no source evidence.",
				});
			} else if (
				transcript.evidenceStatus === "legacy-unverified" &&
				word.sourceRole !== "unknown-mixed"
			) {
				context.addIssue({
					code: "custom",
					path: ["words", index, "sourceRole"],
					message: "Legacy transcript content must stay unknown-mixed.",
				});
			}
		}
	});

const assetVideoSchema = z.object({
	codec: z.string().default("unknown"),
	width: z.number().int().nonnegative().default(0),
	height: z.number().int().nonnegative().default(0),
	fps: z.number().nonnegative().default(0),
});

const assetAudioSchema = z.object({
	codec: z.string().default("unknown"),
	sampleRate: z.number().int().nonnegative().default(0),
	channels: z.number().int().nonnegative().default(0),
});

export const cleanVoiceRecipeSchema = z.discriminatedUnion("mode", [
	z.object({
		version: z.literal(1),
		mode: z.literal("original"),
	}),
	z.object({
		version: z.literal(1),
		mode: z.literal("natural"),
		engine: z.literal("deepfilternet3"),
		attenuationLimitDb: z.number().finite().gt(0).max(30).default(6),
		postFilter: z.literal(false).default(false),
	}),
]);

// ponytail: the webcam is a derived stream — it is NOT edited. Cut / zoom /
// speed live on the main timeline and apply to the camera as a render of the
// same source-time progression. Source path comes from the recording
// session sidecar (auto-linked when an asset is imported from a recording).
// `offsetMs` accounts for the camera starting before/after the screen.
//
// Lives on the asset (not the document) since P4 (per-asset media links) —
// a project can hold multiple assets, each recorded with its own camera (or
// none). See technical-documentation/architecture/document-model.md.
export const cameraTrackSchema = z
	.object({
		sourcePath: z.string().min(1),
		startMs: z.number().nonnegative().default(0),
		offsetMs: z.number().int().default(0),
		visible: z.boolean().default(true),
	})
	.nullable()
	.default(null);

// Why a media can never be transcribed. Only the DETERMINISTIC verdicts live
// here: a container with no audio track (a screen recording captured with no
// mic and no system audio — the common case) fails identically on every
// attempt, and re-deciding that costs a full audio extraction on each project
// open. Transient failures (engine down, decode hiccup) are deliberately NOT
// persistable. Transcription is archived (tag archive/pre-cleanup-2026-10-05);
// the field stays so existing projects keep parsing.
const assetTranscriptionFailureSchema = z.object({
	kind: z.enum(["no-audio", "unsupported-audio"]),
	message: z.string().default(""),
	at: isoDateSchema.optional(),
});

export const assetSchema = z.object({
	id: z.string().min(1),
	kind: z.literal("video"),
	label: z.string().min(1),
	originalPath: z.string().min(1),
	/** Stable owner for a recorder-to-editor import that may retry after interruption. */
	recordingImportId: z.string().min(1).optional(),
	proxyPath: z.string().optional(),
	waveformPath: z.string().optional(),
	durationSec: z.number().nonnegative().optional(),
	// P3.1 — file size captured at import time (fs.stat in document-service).
	sizeBytes: z.number().int().nonnegative().optional(),
	video: assetVideoSchema.optional(),
	audio: assetAudioSchema.optional(),
	/**
	 * Optional user intent only. Missing or `original` selects the immutable raw
	 * microphone. Cleaned media, cache paths, progress, and failures never enter
	 * the project file because they can always be rebuilt.
	 */
	cleanVoice: cleanVoiceRecipeSchema.optional(),
	// Absent on every document written before auto-transcription; additive, so
	// no schema-version bump (an older build simply drops the key on save).
	transcriptionFailure: assetTranscriptionFailureSchema.nullish(),
	cameraTrack: cameraTrackSchema,
	/** Captured original files, copied unchanged by Separate takes. */
	microphoneAudioPath: z.string().min(1).optional(),
	systemAudioPath: z.string().min(1).optional(),
	microphoneAudioOffsetMs: z.number().finite().nonnegative().optional(),
	systemAudioOffsetMs: z.number().finite().nonnegative().optional(),
});

// A crop is a sub-rectangle of the source video, expressed as fractions
// (0-1) of its full frame. Lives on the clip (not the document/legacyEditor
// envelope) since a crop frames one specific piece of footage — two clips
// cut from the same or different assets can reasonably want different
// framings. Mirrors `CropRegion` in `src/components/video-editor/types.ts`;
// duplicated here so the schema package has no dependency on the React
// editor module (same rationale as AnnotationRegion/ZoomRegion above).
const clipCropRegionSchema = z.object({
	x: z.number().min(0).max(1),
	y: z.number().min(0).max(1),
	width: z.number().min(0).max(1),
	height: z.number().min(0).max(1),
});

export const clipSchema = z
	.object({
		id: z.string().min(1),
		assetId: z.string().min(1),
		sourceStartSec: z.number().nonnegative(),
		// ponytail: optional because v2 migrations have unknown asset duration at
		// migration time. The renderer fills this in once StreamingVideoDecoder probes
		// the file (Phase 1+).
		sourceEndSec: z.number().nonnegative().optional(),
		timelineStartSec: z.number().nonnegative(),
		timelineEndSec: z.number().nonnegative(),
		wordRefs: z.array(z.string().min(1)).default([]),
		origin: z.enum(["system", "agent", "user"]),
		reason: z.string().default(""),
		// Absent/undefined means "no crop" (full frame) — callers should treat
		// that as the identity region {x:0,y:0,width:1,height:1} rather than
		// storing the identity explicitly, so untouched clips stay lean.
		cropRegion: clipCropRegionSchema.optional(),
	})
	.refine((data) => data.timelineEndSec >= data.timelineStartSec, {
		message: "timelineEndSec must be greater than or equal to timelineStartSec",
		path: ["timelineEndSec"],
	})
	.refine((data) => data.sourceEndSec === undefined || data.sourceEndSec >= data.sourceStartSec, {
		message: "sourceEndSec must be greater than or equal to sourceStartSec",
		path: ["sourceEndSec"],
	});

const gapSchema = endGteStart(
	z.object({
		id: z.string().min(1),
		timelineStartSec: z.number().nonnegative(),
		timelineEndSec: z.number().nonnegative(),
		reason: z.string().default(""),
	}),
	"timelineEndSec",
	"timelineStartSec",
);

export const rangeSchema = endGteStart(
	z.object({
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		reason: z.string().default(""),
	}),
	"endSec",
	"startSec",
);

// ponytail: trimRanges reference asset source-time (not timeline). trimRegions
// in v2 are the inverse — a skip = the region inside the source we DON'T keep.
//
// `startSec`/`endSec` ARE the source range of `clipAnchorShape` under their older
// names, so a trim needs only `clipId` to become a complete v5 clip anchor. Optional
// for the same reason it is on the other kinds: a trim that could not be anchored
// (`upgradeV6DocumentToV7`) is kept, not dropped, and falls back to the historical
// asset-wide matching. Everything that asks "does this trim apply to this clip?" must
// go through `trimAppliesToClip` (timeline/trim-mapping) so the two rules stay one rule.
export const trimRangeSchema = endGteStart(
	z.object({
		id: z.string().min(1),
		assetId: z.string().min(1),
		clipId: z.string().min(1).optional(),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		reason: z.string().default(""),
		origin: z.enum(["system", "agent", "user"]),
	}),
	"endSec",
	"startSec",
);

export const timelineSchema = z.preprocess(
	// Back-compat: the field was renamed skipRanges → trimRanges. Old persisted
	// documents (disk + browser-shim localStorage) still carry `skipRanges`;
	// fold it into `trimRanges` on load so trims aren't silently dropped.
	(value) => {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const v = value as Record<string, unknown>;
			if (v.skipRanges !== undefined && v.trimRanges === undefined) {
				return { ...v, trimRanges: v.skipRanges };
			}
		}
		return value;
	},
	z.object({
		clips: z.array(clipSchema).default([]),
		audioClips: z.array(audioClipSchema).max(256).optional(),
		gaps: z.array(gapSchema).default([]),
		trimRanges: z.array(trimRangeSchema).default([]),
		muteRanges: z.array(rangeSchema).default([]),
		speedRanges: z.array(rangeSchema).default([]),
		captionRanges: z.array(rangeSchema).default([]),
	}),
);

// OpenScreen additions to the axcut document. Mirrors src/components/video-editor/types.ts
// (AnnotationRegion / ZoomRegion) — duplicated here so the schema package has no
// dependency on the React editor module.

const blurDataSchema = z
	.object({
		type: z.enum(["blur", "mosaic"]).default("mosaic"),
		shape: z.enum(["rectangle", "oval", "freehand"]).default("rectangle"),
		color: z.enum(["white", "black"]).default("white"),
		intensity: z.number().nonnegative().default(12),
		blockSize: z.number().nonnegative().default(12),
		freehandPoints: z
			.array(z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }))
			.optional(),
	})
	.optional();

const figureDataSchema = z
	.object({
		arrowDirection: z
			.enum(["up", "down", "left", "right", "up-right", "up-left", "down-right", "down-left"])
			.default("right"),
		color: z.string().default("#34B27B"),
		strokeWidth: z.number().nonnegative().default(4),
	})
	.optional();

const annotationStyleSchema = z.object({
	preset: z.enum(["card", "lower-third", "label"]).optional(),
	color: z.string().default("#ffffff"),
	backgroundColor: z.string().default("transparent"),
	// `backgroundColor: "transparent"` is how every renderer reads "no background", so switching
	// the background off has to overwrite the colour the user picked — and switching it back on had
	// nothing left to restore, which is why it always came back black. This keeps that last colour
	// so the toggle is reversible. Nothing renders it: the paint path still reads `backgroundColor`
	// alone.
	lastBackgroundColor: z.string().optional(),
	fontSize: z.number().nonnegative().default(32),
	fontFamily: z.string().default("Inter"),
	fontWeight: z.enum(["normal", "bold"]).default("bold"),
	fontStyle: z.enum(["normal", "italic"]).default("normal"),
	textDecoration: z.enum(["none", "underline"]).default("none"),
	textAlign: z.enum(["left", "center", "right"]).default("center"),
	textAnimation: z
		.enum(["none", "fade", "rise", "pop", "slide-left", "typewriter", "pulse"])
		.optional(),
});

// v5 clip anchor — the source of truth for a modifier's position. A region the user drew
// across a clip boundary is stored as one fragment per covered clip; they need no shared
// marker, because two regions with equal properties that touch render as one pill by the
// universal merge rule (see timelineMap). Optional during the Stage B transition: the
// v4→v5 migration fills it in, and regions created by not-yet-migrated code still validate
// on startMs/endMs alone, which remain a DERIVED cache of the fragment's ruler span.
const clipAnchorShape = {
	clipId: z.string().min(1).optional(),
	sourceStartSec: z.number().nonnegative().optional(),
	sourceEndSec: z.number().nonnegative().optional(),
};

/** B-roll video drawn above the screen layer and below the camera for a raw-timeline span. */
const videoOverlaySchema = endGteStart(
	z.object({
		anchor: overlayAnchorSchema.optional(),
		motion: z.enum(["fade", "cut"]).optional(),
		id: z.string().min(1),
		startMs: z.number().nonnegative(),
		endMs: z.number().nonnegative(),
		...clipAnchorShape,
		/** References `assets[].id` (kind video). The overlay never contributes audio. */
		assetId: z.string().min(1),
		/** Overlay source time at `startMs`. */
		sourceOffsetSec: z.number().nonnegative().max(10_800),
		fit: z.enum(["cover", "contain"]).default("cover"),
		/** Percent of the screen layer, top-left plus extent. Null fills the screen layer. */
		placement: z
			.object({
				x: z.number().min(0).max(100),
				y: z.number().min(0).max(100),
				width: z.number().positive().max(100),
				height: z.number().positive().max(100),
			})
			.nullable()
			.default(null),
		opacity: z.number().min(0).max(1).default(1),
	}),
	"endMs",
	"startMs",
);

export const annotationRegionSchema = endGteStart(
	z.object({
		anchor: overlayAnchorSchema.optional(),
		motion: z.enum(["fade", "rise", "cut", "instant"]).optional(),
		id: z.string().min(1),
		startMs: z.number().nonnegative(),
		endMs: z.number().nonnegative(),
		...clipAnchorShape,
		type: z.enum(["text", "image", "figure", "blur"]),
		content: z.string().default(""),
		textContent: z.string().optional(),
		imageContent: z.string().optional(),
		position: z.object({
			x: z.number().min(0).max(100),
			y: z.number().min(0).max(100),
		}),
		size: z.object({
			width: z.number().positive(),
			height: z.number().positive(),
		}),
		style: annotationStyleSchema,
		zIndex: z.number().int().nonnegative(),
		annotationSource: z.literal("auto-caption").optional(),
		figureData: figureDataSchema,
		blurData: blurDataSchema,
	}),
	"endMs",
	"startMs",
);

export const zoomRegionSchema = endGteStart(
	z.object({
		id: z.string().min(1),
		startMs: z.number().nonnegative(),
		endMs: z.number().nonnegative(),
		...clipAnchorShape,
		depth: z.union([
			z.literal(1),
			z.literal(2),
			z.literal(3),
			z.literal(4),
			z.literal(5),
			z.literal(6),
		]),
		focus: z.object({
			cx: z.number().min(0).max(1),
			cy: z.number().min(0).max(1),
		}),
		focusMode: z.enum(["manual", "auto"]).optional(),
		rotationPreset: z.enum(["iso", "left", "right"]).optional(),
		customScale: z.number().positive().optional(),
		motionStyle: z.enum(["smooth", "snappy", "linear", "instant"]).optional(),
		motionSpeed: z.custom<MotionSpeed>(isMotionSpeed, "Invalid motion speed").optional(),
		source: z.enum(["auto", "manual"]).optional(),
		directionGroupId: z.string().min(1).optional(),
		automaticDirection: automaticDirectionProvenanceSchema.optional(),
	}),
	"endMs",
	"startMs",
);

// Legacy OpenScreen appearance / export settings that the v3 schema doesn't
// normalize into the timeline / assets model. They are applied at export time
// by the existing pipeline (see technical-documentation/architecture/document-model.md).
//
// ponytail: passthrough blob — v2 ProjectEditorState carries ~25 fields, several
// of which (autoZoomEnabled, autoFocusAll, cursorTheme, …) have no first-class
// home yet. Phase 1 timeline rewrite + Phase 9 settings sync will tighten this.
// Round-trip through the migration must be lossless for now.
export const legacyEditorSchema = z
	.object({
		safeMarginPercent: z.number().finite().min(0).max(50).optional(),
		cameraAnchor: cameraAnchorSchema.optional(),
	})
	.passthrough()
	.superRefine((legacy, context) => {
		// Tighten only new provenance; older legacy settings keep their existing contract.
		if (!Array.isArray(legacy.cameraFullscreenRegions)) return;
		legacy.cameraFullscreenRegions.forEach((region: unknown, index: number) => {
			if (
				!region ||
				typeof region !== "object" ||
				!("automaticDirection" in region) ||
				region.automaticDirection === undefined
			)
				return;
			if (!automaticDirectionProvenanceSchema.safeParse(region.automaticDirection).success) {
				context.addIssue({
					code: "custom",
					message: "Invalid automatic direction provenance",
					path: ["cameraFullscreenRegions", index, "automaticDirection"],
				});
			}
		});
	})
	.nullable()
	.default(null);

const documentSchemaShape = z.object({
	schemaVersion: z.literal(axcutSchemaVersion),
	project: z.object({
		id: z.string().min(1),
		title: z.string().min(1),
		createdAt: isoDateSchema,
		updatedAt: isoDateSchema,
		primaryAssetId: z.string().optional(),
	}),
	assets: z.array(assetSchema).default([]),
	audioAssets: z.array(audioAssetSchema).max(256).optional(),
	transcript: transcriptSchema.nullable().default(null),
	transcripts: z.array(transcriptSchema).default([]),
	timeline: timelineSchema.default({
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	}),
	annotations: z.array(annotationRegionSchema).default([]),
	videoOverlays: z.array(videoOverlaySchema).max(256).optional(),
	zoomRanges: z.array(zoomRegionSchema).default([]),
	automaticDirectionDismissals: automaticDirectionDismissalsSchema.optional(),
	legacyEditor: legacyEditorSchema.nullable().default(null),
	clipLayouts: z.record(z.string().min(1), clipLayoutOverrideSchema).optional(),
});

// P4 — v3 documents carried a single project-level `cameraTrack` (one project
// = one camera, inherited from the pre-multi-clip editor). v4 moves it onto
// the owning asset (see `assetSchema.cameraTrack` above) so each asset in a
// multi-clip project can carry its own camera link. This is invoked at LOAD
// TIME by `migrateRawDocumentToCurrent` in `document/migrate.ts`, not at every
// `documentSchema.parse(...)` call (the parse is now a pure v6 validation
// step — see the comment above `documentSchema` below). It does NOT touch v2
// (still handled solely by the separate `migrateProjectDataToAxcutDocument`
// pure function) or reject unknown versions; anything that isn't exactly v3
// passes through unchanged so the caller's `documentSchema.parse` can
// reject it via the `schemaVersion` literal.
function upgradeV3DocumentToV4(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 3) return raw;

	const legacyCameraTrack = doc.cameraTrack ?? null;
	const assets = Array.isArray(doc.assets) ? doc.assets : [];
	const project = (doc.project ?? {}) as { primaryAssetId?: string };
	const targetAssetId = project.primaryAssetId ?? (assets[0] as { id?: string } | undefined)?.id;

	const nextAssets = assets.map((asset) => {
		if (!asset || typeof asset !== "object") return asset;
		const a = asset as Record<string, unknown>;
		return legacyCameraTrack && a.id === targetAssetId && a.cameraTrack === undefined
			? { ...a, cameraTrack: legacyCameraTrack }
			: a;
	});

	const { cameraTrack: _legacyCameraTrack, ...rest } = doc;
	return { ...rest, schemaVersion: 4, assets: nextAssets };
}

/**
 * v4 → v5 — modifiers become CLIP-ANCHORED fragments. Every RAW-virtual-ms region
 * (document `zoomRanges` / `annotations`, plus the `legacyEditor.speedRegions` /
 * `cameraFullscreenRegions` envelopes) is ventilated across the stored RAW clip
 * layout it was authored against, yielding one fragment per covered clip, with
 * `startMs`/`endMs` re-derived as a transition cache. The fragments carry no marker
 * tying them together: they share the same properties, so the ruler already renders
 * them as one pill whenever they are adjacent (see timelineMap merge rule).
 *
 * A region covering no clip (zero-length, or off the end of the timeline) is
 * dropped: it could never play. A document with no clips has nothing to anchor to,
 * so its regions pass through untouched (still valid — the anchor is optional).
 *
 * Invoked at LOAD TIME by `migrateRawDocumentToCurrent` in `document/migrate.ts`,
 * not at every `documentSchema.parse(...)` call.
 */
function upgradeV4DocumentToV5(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 4) return raw;

	const timeline = (doc.timeline ?? {}) as Record<string, unknown>;
	const clips = (Array.isArray(timeline.clips) ? timeline.clips : []) as unknown as AxcutClip[];

	const anchor = (value: unknown, prefix: string): unknown => {
		if (!Array.isArray(value) || clips.length === 0) return value;
		return anchorRegionsWithDerivedMs(
			value as Array<{ id: string; startMs: number; endMs: number }>,
			clips,
			() => createId(prefix),
		);
	};

	const legacy =
		doc.legacyEditor && typeof doc.legacyEditor === "object" && !Array.isArray(doc.legacyEditor)
			? (doc.legacyEditor as Record<string, unknown>)
			: null;

	return {
		...doc,
		schemaVersion: 5,
		zoomRanges: anchor(doc.zoomRanges, "zoom"),
		annotations: anchor(doc.annotations, "ann"),
		legacyEditor: legacy
			? {
					...legacy,
					...(Array.isArray(legacy.speedRegions)
						? { speedRegions: anchor(legacy.speedRegions, "speed") }
						: {}),
					...(Array.isArray(legacy.cameraFullscreenRegions)
						? { cameraFullscreenRegions: anchor(legacy.cameraFullscreenRegions, "camfull") }
						: {}),
				}
			: doc.legacyEditor,
	};
}

/**
 * Largest raw asset footprint among the timeline's clips. A local copy of the
 * `referenceClipDims` pick from `document/outputFormat` — duplicated here so the schema
 * package doesn't import from a module that itself imports from this one (cycle), and so
 * the upgrader doesn't need the runtime `probedAssetDims` map (it runs at load time, before
 * any asset is probed). Crop IS applied: `"native"` resolved to the *cropped* clip
 * dimensions at runtime (`clipEffectiveDims` → `calculateEffectiveSourceDimensions`),
 * so ignoring it here would silently reframe every cropped project.
 */
/** Mirrors `atLeastEven` in mp4ExportSettings — H.264 4:2:0 rejects odd dims. */
function atLeastEven(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

function largestClipDims(doc: Record<string, unknown>): { width: number; height: number } | null {
	const timeline = (doc.timeline ?? {}) as Record<string, unknown>;
	const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
	const assets = Array.isArray(doc.assets) ? doc.assets : [];
	const assetById = new Map<string, Record<string, unknown>>();
	for (const a of assets) {
		if (a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string") {
			assetById.set((a as { id: string }).id, a as Record<string, unknown>);
		}
	}
	let best: { width: number; height: number } | null = null;
	let bestArea = 0;
	for (const clip of clips) {
		if (!clip || typeof clip !== "object") continue;
		const c = clip as Record<string, unknown>;
		const assetId = c.assetId;
		if (typeof assetId !== "string") continue;
		const asset = assetById.get(assetId);
		if (!asset) continue;
		const video = (asset.video ?? {}) as Record<string, unknown>;
		const rawW = typeof video.width === "number" ? video.width : 0;
		const rawH = typeof video.height === "number" ? video.height : 0;
		if (rawW <= 0 || rawH <= 0) continue;
		// Apply the clip's crop, exactly as `calculateEffectiveSourceDimensions`
		// (mp4ExportSettings) does at runtime — including the snap to even pixels,
		// so the reduced token matches the size the encoder is actually handed.
		// "native" meant "the cropped source's shape"; ignoring crop here would
		// bake the wrong ratio into every cropped project.
		const crop = (c.cropRegion ?? {}) as Record<string, unknown>;
		const cropW = typeof crop.width === "number" && crop.width > 0 ? crop.width : 1;
		const cropH = typeof crop.height === "number" && crop.height > 0 ? crop.height : 1;
		const w = atLeastEven(Math.round(rawW * cropW));
		const h = atLeastEven(Math.round(rawH * cropH));
		const area = w * h;
		if (area > bestArea) {
			bestArea = area;
			best = { width: w, height: h };
		}
	}
	return best;
}

/**
 * v5 → v6 — retire the `"native"` AspectRatio. `"native"` was a runtime-only sentinel
 * that resolved to the timeline's largest clip; v6 makes that resolution permanent by
 * baking the concrete `"W:H"` token into the document. The new value matches the OLD
 * runtime answer (largest clip), so projects migrate losslessly — preview and export
 * will keep framing the same shape they did yesterday.
 *
 * Falls back to `"16:9"` when the timeline has no clips with known dimensions (the same
 * value the runtime bridge in `resolveAspectRatioValue` returned when no document was
 * available). A document without a `legacyEditor` envelope is unchanged apart from the
 * version bump.
 */
function upgradeV5DocumentToV6(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 5) return raw;

	const legacy =
		doc.legacyEditor && typeof doc.legacyEditor === "object" && !Array.isArray(doc.legacyEditor)
			? (doc.legacyEditor as Record<string, unknown>)
			: null;

	if (!legacy || legacy.aspectRatio !== "native") {
		return { ...doc, schemaVersion: 6 };
	}

	// OPPORTUNISTIC, never forced. Baking requires real source dimensions, and a
	// project imported from v1.7 has none yet: `migrateProjectDataToAxcutDocument`
	// builds its asset from `{version:2, media, editor}`, which carries only file
	// paths — dimensions arrive later, when `useAssetDimensionBackfill`'s probe effect writes
	// `asset.video` back to disk.
	//
	// So when dimensions are unknown we leave `"native"` in place rather than
	// stamping a hardcoded ratio. `"native"` keeps resolving dynamically at runtime
	// (`resolveAspectRatioValue`), which IS the v1.7 behaviour, and the next load
	// after the probe has persisted dimensions converts it for real. Forcing
	// `"16:9"` here would permanently reframe every portrait v1.7 project that used
	// "Native", on its first open in v1.8, with no way back.
	const dims = largestClipDims(doc);
	if (!dims) {
		return { ...doc, schemaVersion: 6 };
	}
	return {
		...doc,
		schemaVersion: 6,
		legacyEditor: { ...legacy, aspectRatio: toAspectRatioToken(dims.width, dims.height) },
	};
}

/**
 * v6 → v7 — trims become CLIP-ANCHORED, the last region kind that wasn't.
 *
 * A v6 trim says only "this source span of this asset is cut". That is unambiguous while
 * one asset backs one clip, and ambiguous the moment it doesn't: with two clips over the
 * same media every reader had to guess, and each guessed differently — the transcript pane
 * showed the cut on BOTH clips, the ruler drew it on the FIRST, and playback/export removed
 * the span from BOTH. Anchoring the trim to the clip it was authored on removes the guess.
 *
 * The upgrade VENTILATES rather than picks: a stored trim is replaced by one anchored entry
 * per clip it currently covers, each clamped to that clip's source window. That is a
 * faithful restatement of what the document already renders (a v6 trim really did cut every
 * clip of its asset), so nothing about the output moves — but the entries are now separately
 * addressable, which is what lets a user delete the copy on the clip they didn't mean.
 * Mirrors `upgradeV4DocumentToV5`, which ventilated the other kinds the same way.
 *
 * A trim covering no clip is kept UNCHANGED rather than dropped — never lose user data.
 * `replaceTimeline` mints exactly such trims (the inverted kept-intervals lie outside every
 * clip by construction), and a document with no clips has nothing to anchor against.
 * Un-anchored trims keep the v6 asset-wide behaviour via `trimAppliesToClip`.
 */
function upgradeV6DocumentToV7(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 6) return raw;

	const timeline =
		doc.timeline && typeof doc.timeline === "object" && !Array.isArray(doc.timeline)
			? (doc.timeline as Record<string, unknown>)
			: null;
	const trims = timeline && Array.isArray(timeline.trimRanges) ? timeline.trimRanges : null;
	const clips = (timeline && Array.isArray(timeline.clips)
		? timeline.clips
		: []) as unknown as AxcutClip[];
	if (!timeline || !trims || clips.length === 0) return { ...doc, schemaVersion: 7 };

	const anchored = trims.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [entry];
		const trim = entry as Record<string, unknown>;
		// Already anchored (a re-run, or a doc written by a mixed-version chain): leave it.
		if (typeof trim.clipId === "string") return [trim];
		if (typeof trim.assetId !== "string") return [trim];
		if (typeof trim.startSec !== "number" || typeof trim.endSec !== "number") return [trim];
		const lo = Math.min(trim.startSec, trim.endSec);
		const hi = Math.max(trim.startSec, trim.endSec);

		const fragments = clips.flatMap((clip) => {
			// `clips` is raw, untrusted input at this point (the schema parse runs after the
			// upgrade chain), so a malformed entry must not take the whole project load down.
			if (!clip || typeof clip !== "object" || typeof clip.id !== "string") return [];
			if (clip.assetId !== trim.assetId) return [];
			const clipEnd = clip.sourceEndSec ?? clip.sourceStartSec;
			// An unprobed clip has no real window yet; anchoring against it would clamp the
			// trim to nothing. Leave those to the un-anchored fallback (same reasoning as
			// `rederiveRegionMs`, which refuses to clamp against an unprobed window).
			if (clipEnd <= clip.sourceStartSec) return [];
			const startSec = Math.max(lo, clip.sourceStartSec);
			const endSec = Math.min(hi, clipEnd);
			if (endSec <= startSec) return [];
			return [{ ...trim, clipId: clip.id, startSec, endSec }];
		});
		if (fragments.length === 0) return [trim];
		// The first fragment keeps the original id, so ids already held elsewhere (an undo
		// entry, an in-flight `removeTrim`) still resolve; extras get fresh ones.
		return fragments.map((f, i) => (i === 0 ? f : { ...f, id: createId("trim") }));
	});

	return { ...doc, schemaVersion: 7, timeline: { ...timeline, trimRanges: anchored } };
}

/**
 * v7 → v8 — reserve a typed asset-level Clean Voice recipe without changing
 * existing sound. Missing is the canonical Original setting, so the migration
 * changes only the version marker and cannot start background work.
 */
function upgradeV7DocumentToV8(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	return doc.schemaVersion === 7 ? { ...doc, schemaVersion: 8 } : raw;
}

/** v8 → v9 — label legacy transcript content without inventing a speaker. */
function upgradeV8DocumentToV9(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 8) return raw;
	const upgradeTranscript = (value: unknown) => {
		if (!value || typeof value !== "object") return value;
		const transcript = value as Record<string, unknown>;
		const words = Array.isArray(transcript.words)
			? transcript.words.map((word) =>
					word && typeof word === "object"
						? { sourceRole: "unknown-mixed", ...(word as Record<string, unknown>) }
						: word,
				)
			: [];
		const segments = Array.isArray(transcript.segments)
			? transcript.segments.map((segment) =>
					segment && typeof segment === "object"
						? { sourceRole: "unknown-mixed", ...(segment as Record<string, unknown>) }
						: segment,
				)
			: [];
		return {
			...transcript,
			words,
			segments,
			evidenceStatus: "legacy-unverified",
			sources: [],
		};
	};
	return {
		...doc,
		schemaVersion: 9,
		transcript: upgradeTranscript(doc.transcript),
		transcripts: Array.isArray(doc.transcripts) ? doc.transcripts.map(upgradeTranscript) : [],
	};
}

/**
 * Runs the whole upgrade chain on a raw, untrusted value. Idempotent: each step
 * is gated on an exact `schemaVersion`, so an already-current document passes
 * through untouched.
 *
 * Lives here rather than in `document/migrate.ts` on purpose — the Electron main
 * process imports this composer, and `migrate.ts` pulls a value import
 * (`PROJECT_VERSION`) through the `@/` alias, which `vite-plugin-electron` does
 * not configure for the main bundle. Keep this module alias-free.
 */
export function migrateRawDocumentToCurrent(raw: unknown): unknown {
	return upgradeV10DocumentToV11(
		upgradeV9DocumentToV10(
			upgradeV8DocumentToV9(
				upgradeV7DocumentToV8(
					upgradeV6DocumentToV7(
						upgradeV5DocumentToV6(upgradeV4DocumentToV5(upgradeV3DocumentToV4(raw))),
					),
				),
			),
		),
	);
}

/** v11 owns video B-roll overlays. Older readers must reject rather than silently drop them. */
export function upgradeV10DocumentToV11(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || !("schemaVersion" in raw) || raw.schemaVersion !== 10)
		return raw;
	return { ...raw, schemaVersion: 11, videoOverlays: [] };
}

/** v10 owns editable audio overlays. Older readers must reject rather than silently drop them. */
export function upgradeV9DocumentToV10(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || !("schemaVersion" in raw) || raw.schemaVersion !== 9)
		return raw;
	return { ...raw, schemaVersion: 10 };
}

// PURE v8 validation. Callers that read a document from disk (or any other
// source that might carry an older `schemaVersion`) MUST run
// `migrateRawDocumentToCurrent` on the raw value first. The previous
// implementation wrapped this schema in a `z.preprocess` that re-ran the whole
// v3→…→v8 chain on EVERY parse, including in-memory parses of documents that
// were already current. Hoisting it to load time makes the in-memory parse a
// single `z.literal(8)` + shape check.
export const documentSchema = documentSchemaShape.superRefine((doc, ctx) => {
	const videoAssetIds = new Set(doc.assets.map((asset) => asset.id));
	(doc.videoOverlays ?? []).forEach((overlay, index) => {
		if (!videoAssetIds.has(overlay.assetId))
			ctx.addIssue({
				code: "custom",
				path: ["videoOverlays", index, "assetId"],
				message: `Missing video asset for overlay ${overlay.id}`,
			});
	});
	try {
		validateAudioReferences(doc.audioAssets ?? [], doc.timeline.audioClips ?? []);
	} catch (error) {
		ctx.addIssue({
			code: "custom",
			path: ["timeline", "audioClips"],
			message: error instanceof Error ? error.message : "Invalid audio references",
		});
	}
});

const createProjectInputSchema = z.object({
	title: z.string().trim().min(1).default("Untitled Project"),
});
export type AxcutWord = z.infer<typeof wordSchema>;
export type AxcutTranscript = z.infer<typeof transcriptSchema>;
export type AxcutAsset = z.infer<typeof assetSchema>;
export type CleanVoiceRecipe = z.infer<typeof cleanVoiceRecipeSchema>;
export type AxcutClip = z.infer<typeof clipSchema>;
export type AxcutTrimRange = z.infer<typeof trimRangeSchema>;
export type AxcutAnnotationRegion = z.infer<typeof annotationRegionSchema>;
export type AxcutZoomRegion = z.infer<typeof zoomRegionSchema>;
export type AxcutCameraTrack = z.infer<typeof cameraTrackSchema>;
export type AxcutLegacyEditor = z.infer<typeof legacyEditorSchema>;
export type AxcutDocument = z.infer<typeof documentSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export function createEmptyDocument(
	input: CreateProjectInput & { projectId: string; createdAt?: string },
): AxcutDocument {
	const createdAt = input.createdAt ?? new Date().toISOString();
	return documentSchema.parse({
		schemaVersion: axcutSchemaVersion,
		project: {
			id: input.projectId,
			title: input.title,
			createdAt,
			updatedAt: createdAt,
		},
		assets: [],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		videoOverlays: [],
		zoomRanges: [],
		legacyEditor: null,
	});
}

export function ensureDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}

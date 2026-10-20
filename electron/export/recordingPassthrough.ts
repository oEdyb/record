import { z } from "zod";
import type { CompositorClipInput } from "../../src/native/contracts";
import type {
	ResolvedClipLayout,
	SceneCursor,
	SceneDescription,
	SceneEffects,
	SceneLayout,
} from "../../src/native/sceneDescription";
import type { ClipInput, ExportParamsInput } from "../native/compositor-view/addon";

const fullFrame = z.strictObject({
	x: z.literal(0),
	y: z.literal(0),
	width: z.literal(1),
	height: z.literal(1),
});
const focalPoint = z.strictObject({ cx: z.number(), cy: z.number() });
const noRadius = z.union([z.literal(0), z.null()]);
const webcamShape = z.enum(["rectangle", "circle", "square", "rounded", "squircle"]);
const clipFields = {
	screenPath: z.string(),
	webcamPath: z.string(),
	sourceStartSec: z.literal(0),
	sourceEndSec: z.number(),
	webcamOffsetSec: z.number(),
	hasAudio: z.boolean(),
	cleanMicrophonePath: z.undefined().optional(),
} satisfies Record<keyof CompositorClipInput, z.ZodType>;
const resolvedLayoutFields = {
	screenRect: fullFrame,
	webcamRect: z.null(),
	screenRadiusFrac: noRadius,
	webcamRadiusFrac: z.number().nullable(),
	webcamShape,
	screenCover: z.literal(false),
} satisfies Record<keyof ResolvedClipLayout, z.ZodType>;
const layoutFields = {
	preset: z.enum(["picture-in-picture", "dual-frame", "vertical-stack", "no-webcam"]),
	webcamSize: z.number(),
	webcamZoom: z.number(),
	webcamFocalPoint: focalPoint,
	screenZoom: z.literal(1),
	screenFocalPoint: z.strictObject({ cx: z.literal(0.5), cy: z.literal(0.5) }),
	webcamShape,
	webcamMirror: z.boolean(),
	webcamPosition: focalPoint.nullable(),
	webcamReactiveZoom: z.boolean(),
	webcamRect: z.null(),
	screenRect: fullFrame,
	screenCover: z.literal(false),
	layoutByClip: z.array(z.strictObject(resolvedLayoutFields).nullable()).optional(),
	screenRadiusFrac: noRadius.optional(),
	webcamRadiusFrac: z.number().nullable().optional(),
} satisfies Record<keyof SceneLayout, z.ZodType>;
const effectFields = {
	padding: z.literal(0),
	blur: z.literal(false),
	shadow: z.literal(0),
	roundnessFrac: z.literal(0),
	motionBlur: z.literal(0),
} satisfies Record<keyof SceneEffects, z.ZodType>;
const cursorFields = {
	show: z.boolean(),
	size: z.number(),
	smoothing: z.number(),
	motionBlur: z.number(),
	clickBounce: z.number(),
	clipToBounds: z.boolean(),
	theme: z.string(),
} satisfies Record<keyof SceneCursor, z.ZodType>;
const empty = z.array(z.never()).length(0);
// Exhaustive field maps make new compositor features fail the typecheck until
// their effect on source preservation has been reviewed. Unknown payload keys
// also fall back to the compositor instead of silently dropping new features.
const sceneFields = {
	audioOverlays: empty.optional(),
	clips: z.array(z.strictObject(clipFields)).min(1),
	layout: z.strictObject(layoutFields),
	effects: z.strictObject(effectFields),
	background: z.unknown(),
	zoomRegions: empty,
	annotations: empty,
	cameraFullscreenRegions: empty,
	videoOverlays: empty.optional(),
	speedRegions: empty,
	cursor: z.strictObject(cursorFields),
	cropByClip: z.array(fullFrame.nullable()),
	output: z.strictObject({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		fps: z.number().positive().nullable(),
	}),
} satisfies Record<keyof SceneDescription, z.ZodType>;
const identityScene = z.strictObject(sceneFields);

export interface RecordingPassthroughRequest {
	clips: ClipInput[];
	sceneJson?: string;
	params?: ExportParamsInput;
	/** Each clip's complete source duration, in clip order. */
	sourceDurationsSec: number[];
	hasCursorTrack: boolean;
}

/** Only an explicitly requested set of complete recordings whose scene covers
 * the output unchanged can bypass the compositor. Takes split by Pause are
 * joined back to back. The explicit opt-in preserves original timestamps,
 * cadence and bitrate; FPS and bitrate then describe only the rendered
 * fallback. Ordinary exports retain their encoding contract. */
export function canPreserveRecordingSource(request: RecordingPassthroughRequest): boolean {
	const { clips, params, sourceDurationsSec, hasCursorTrack } = request;
	if (
		params?.preserveRecordingSource !== true ||
		params.evenVolume !== false ||
		params.normalizeAudio !== false ||
		(params.codec !== undefined && params.codec !== "h264" && params.codec !== "h265") ||
		clips.length === 0 ||
		sourceDurationsSec.length !== clips.length ||
		!sourceDurationsSec.every((duration) => Number.isFinite(duration) && duration > 0) ||
		!request.sceneJson
	)
		return false;
	const complete = clips.every(
		(clip, index) =>
			clip.sourceStartSec === 0 &&
			clip.sourceEndSec === sourceDurationsSec[index] &&
			!clip.cleanMicrophonePath &&
			(!clip.webcamPath || clip.webcamPath === clip.screenPath),
	);
	if (!complete) return false;
	try {
		const parsed = identityScene.safeParse(JSON.parse(request.sceneJson));
		if (!parsed.success) return false;
		const scene = parsed.data;
		return (
			scene.clips.length === clips.length &&
			scene.cropByClip.length === clips.length &&
			(scene.layout.layoutByClip === undefined ||
				scene.layout.layoutByClip.length === clips.length) &&
			scene.clips.every((sceneClip, index) => {
				const clip = clips[index]!;
				return (
					sceneClip.screenPath === clip.screenPath &&
					sceneClip.webcamPath === clip.webcamPath &&
					sceneClip.webcamOffsetSec === clip.webcamOffsetSec &&
					sceneClip.hasAudio === clip.hasAudio &&
					sceneClip.sourceEndSec >= sourceDurationsSec[index]!
				);
			}) &&
			!(scene.cursor.show && hasCursorTrack) &&
			scene.output.width === (Math.max(2, params.width ?? 1920) & ~1) &&
			scene.output.height === (Math.max(2, params.height ?? 1080) & ~1)
		);
	} catch {
		return false;
	}
}

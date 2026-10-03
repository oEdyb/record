import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ANNOTATION_REFERENCE_HEIGHT } from "../../src/lib/ai-edition/annotationScale";
import { pickOutputDims } from "../../src/lib/ai-edition/document/outputFormat";
import {
	anchorPosition,
	CAMERA_ANCHORS,
	CAMERA_EMPHASIS_SCALES,
	overlayRect,
	SPEECH_MOTION,
	textSizeFraction,
	ZOOM_SCALES,
} from "../../src/lib/ai-edition/layout/vocabulary";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import type { OverlayAnchor } from "../../src/lib/ai-edition/schema/overlayAnchor";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import { findPhrase, resolveOverlaySpan } from "../../src/lib/ai-edition/timeline/overlayAnchors";
import {
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
} from "../../src/lib/ai-edition/timeline/timelineMap";
import { buildSceneDescription, resolveVisibleClips } from "../../src/native/sceneDescription";
import { agentEditOperationSchema } from "../ai-edition/agentEditPlan";
import type { AgentBrokerRequest } from "./agentBroker";
import type { ClipReplacementIntent } from "./agentClip";
import { unknownCommitRecoveryHint } from "./agentOutputContract";
import { resolveEditedSeconds, type TimeInput, timeInputSchema } from "./agentTimeBase";

// Edited stays the default base (documented phase-2 behavior); the e/r/s
// suffixes name the clock explicitly and buildPlacement converts.
export const placementTime = timeInputSchema("edited");
const common = {
	project_id: z.string().min(1).max(256),
	from: placementTime.optional(),
	to: placementTime.optional(),
	at: placementTime.optional(),
	words: z.string().min(1).max(4000).optional(),
	request_id: z.string().min(1).max(128).optional(),
	force: z.boolean().default(false),
};
const textInput = z.strictObject({
	...common,
	action: z.literal("add"),
	text: z.string().min(1).max(4000),
	anchor: z.enum(CAMERA_ANCHORS).default("top"),
	size: z.enum(["XS", "S", "M", "L", "XL"]).default("M"),
	style: z.enum(["card", "lower-third", "label"]).default("card"),
	motion: z.enum(["fade", "rise", "cut", "instant"]).default("fade"),
});
const brollInput = z.strictObject({
	...common,
	action: z.literal("add"),
	file: z.string().min(1).max(4096).refine(path.isAbsolute, "File must be absolute"),
	fit: z.enum(["cover", "contain"]).default("cover"),
	anchor: z.enum(CAMERA_ANCHORS).default("center"),
	size: z.enum(["S", "M", "L", "XL"]).default("M"),
	motion: z.enum(["fade", "cut"]).default("cut"),
	offset: z.number().finite().nonnegative().default(0),
});
const zoomInput = z.strictObject({
	...common,
	action: z.literal("add"),
	speed: z.enum(["quick", "normal", "slow"]).default("normal"),
	size: z.enum(["S", "M", "L", "XL"]).default("M"),
	anchor: z.enum(CAMERA_ANCHORS).default("center"),
});
const cameraInput = z.strictObject({
	...common,
	action: z.literal("set"),
	mode: z.enum(["full", "emphasis"]),
	size: z.enum(["S", "M", "L", "XL"]).default("M"),
});
function validTiming(v: { from?: TimeInput; to?: TimeInput; at?: TimeInput; words?: string }) {
	return (
		!(
			v.at !== undefined &&
			(v.from !== undefined || v.to !== undefined || v.words !== undefined)
		) &&
		(v.words !== undefined || v.at !== undefined || (v.from !== undefined && v.to !== undefined)) &&
		(v.from === undefined) === (v.to === undefined)
	);
}
export const textCommandInput = textInput
	.refine(validTiming, "Use --from/--to or --words")
	.refine((v) => v.at === undefined, "Text requires a span");
const brollAddCommandInput = brollInput
	.refine(validTiming, "Use --from/--to or --words")
	.refine((v) => v.at === undefined, "B-roll requires a span");
export const brollSwapCommandInput = z.strictObject({
	project_id: common.project_id,
	action: z.literal("swap"),
	overlay: z.string().min(1).max(256),
	file: z.string().min(1).max(4096).refine(path.isAbsolute, "Supply an absolute local file path"),
	offset: z.number().finite().nonnegative().default(0),
	fit: z.enum(["auto", "cover", "contain"]).default("auto"),
	time: z.enum(["trim", "hold"]).default("trim"),
	request_id: common.request_id,
	force: common.force,
});
export const brollCommandInput = z.discriminatedUnion("action", [
	brollAddCommandInput,
	brollSwapCommandInput,
]);
export type BrollSwapIntent = z.infer<typeof brollSwapCommandInput> & { kind: "broll-swap" };
export const zoomCommandInput = zoomInput.refine(validTiming, "Use --at, --from/--to, or --words");
export const cameraCommandInput = cameraInput.refine(
	validTiming,
	"Use --at, --from/--to, or --words",
);
export const placementIntentSchema = z.discriminatedUnion("kind", [
	textCommandInput.safeExtend({ kind: z.literal("text") }),
	brollAddCommandInput.safeExtend({ kind: z.literal("broll") }),
	zoomCommandInput.safeExtend({ kind: z.literal("zoom") }),
	cameraCommandInput.safeExtend({ kind: z.literal("camera") }),
]);
export type PlacementIntent = z.infer<typeof placementIntentSchema>;

export function buildPlacement(document: AxcutDocument, input: PlacementIntent) {
	const visible = resolveVisibleClips(document);
	const projection = buildTimelinePlaybackProjection(visible, document.timeline.clips);
	const duration = projection.at(-1)?.playbackEndSec ?? 0;
	const minimum = input.kind === "text" ? 1.5 : input.kind === "broll" ? 0 : 0.8;
	let from =
		(input.from ?? input.at) ? resolveEditedSeconds(document, (input.from ?? input.at)!) : 0;
	let to = input.to ? resolveEditedSeconds(document, input.to) : from + minimum;
	let anchor: OverlayAnchor;
	if (input.words) {
		const matches = findPhrase(document, input.words).flatMap((match) => {
			const span = resolveOverlaySpan(document, visible, match);
			return span &&
				(input.from === undefined ||
					(span.fromSec >= from && span.toSec <= (input.to ? to : Infinity)))
				? [{ match, span }]
				: [];
		});
		if (matches.length !== 1)
			throw new Error(
				matches.length
					? "WORDS_AMBIGUOUS: Supply --from/--to to select one occurrence."
					: "WORDS_NOT_FOUND: Exact phrase is not present in kept footage.",
			);
		from = matches[0].span.fromSec;
		to = matches[0].span.toSec;
		anchor = { ...matches[0].match, minimumDurationSec: minimum };
	} else anchor = { kind: "edited", fromSec: from, toSec: to };
	if (to < from) throw new Error("INVALID_RANGE: End precedes start.");
	const requestedTo = to;
	to = Math.max(to, from + minimum);
	const notes: string[] =
		to > requestedTo
			? [`Extended end from ${requestedTo}s to ${to}s for the ${minimum}s minimum.`]
			: [];
	if (input.kind === "zoom" || input.kind === "camera") {
		const before = { from, to };
		const cuts = projection.slice(1).map((part) => part.playbackStartSec);
		const snap = (time: number) =>
			cuts.reduce(
				(nearest, cut) =>
					Math.abs(cut - time) <= 0.6 + 0.000001 && Math.abs(cut - time) < Math.abs(nearest - time)
						? cut
						: nearest,
				Number.POSITIVE_INFINITY,
			);
		const snappedFrom = snap(from);
		const snappedTo = snap(to);
		if (Number.isFinite(snappedFrom)) from = snappedFrom;
		if (Number.isFinite(snappedTo)) to = snappedTo;
		to = Math.max(to, from + minimum);
		for (const part of projection) {
			const start = Math.max(from, part.playbackStartSec);
			const end = Math.min(to, part.playbackEndSec);
			if (end <= start || end - start >= minimum - 0.000001) continue;
			if (part.playbackEndSec - part.playbackStartSec < minimum - 0.000001)
				throw new Error("MINIMUM_PIECE_UNAVAILABLE: A kept fragment is shorter than 0.8 seconds.");
			if (start > part.playbackStartSec) from = part.playbackEndSec - minimum;
			else to = part.playbackStartSec + minimum;
		}
		if (from !== before.from || to !== before.to)
			notes.push(
				`Snapped/extended speech span from ${before.from}-${before.to}s to ${from}-${to}s; each kept piece is at least 0.8s.`,
			);
	}
	if (from < 0 || from >= duration || to > duration || to <= from)
		throw new Error(
			"INVALID_RANGE: Span including its minimum duration must fit the edited timeline.",
		);
	if (anchor.kind === "edited") anchor = { ...anchor, fromSec: from, toSec: to };
	const startSec = playbackTimeToRawTime(from, projection, "after");
	const endSec = playbackTimeToRawTime(to, projection, "before");
	const settings = getEditorSettings(document);
	const canvas = pickOutputDims(document, settings.aspectRatio, {}, settings.outputResolution);
	const span = { startSec: from, endSec: to };
	if (input.kind === "text") {
		const scene = buildSceneDescription(document);
		const clipIndex = projection.findIndex(
			(part) => part.playbackStartSec <= from && part.playbackEndSec > from,
		);
		const screen = scene.layout.layoutByClip?.[clipIndex]?.screenRect ?? scene.layout.screenRect;
		const screenHeight = screen?.height ?? 1;
		if (screenHeight <= 0)
			throw new Error("TEXT_LAYOUT_UNAVAILABLE: Screen height must be positive.");
		const textCanvas = {
			width: canvas.width * (screen?.width ?? 1),
			height: canvas.height * screenHeight,
		};
		if (
			projection.some(
				(part, index) =>
					part.playbackStartSec < to &&
					part.playbackEndSec > from &&
					Math.abs(
						(scene.layout.layoutByClip?.[index]?.screenRect?.height ??
							scene.layout.screenRect?.height ??
							1) - screenHeight,
					) > 1e-6,
			)
		)
			notes.push(
				"Text size uses the screen rectangle at the start of the span; its frame-height fraction changes on clips with a different screen height.",
			);
		const rect = overlayRect(
			"text",
			input.style === "lower-third" ? "bottom-left" : input.anchor,
			input.size,
			textCanvas,
			settings.safeMarginPercent,
			input.style,
			canvas.height,
		);
		const fontSize =
			(textSizeFraction(input.size, input.style) / screenHeight) * ANNOTATION_REFERENCE_HEIGHT;
		if (rect.height > 100 || rect.y < 0 || fontSize > 512)
			throw new Error(
				"TEXT_LAYOUT_UNAVAILABLE: This text size does not fit the screen rectangle. Choose a smaller size or a taller screen layout.",
			);
		const operation = agentEditOperationSchema.parse({
			type: "addAnnotation",
			args: {
				startSec,
				endSec,
				text: input.text,
				anchor,
				motion: input.motion,
				position: { x: rect.x, y: rect.y },
				size: { width: rect.width, height: rect.height },
				style: {
					preset: input.style,
					fontSize,
					backgroundColor: "#171717",
					textAlign: input.style === "lower-third" ? "left" : "center",
					textAnimation:
						input.motion === "cut" || input.motion === "instant" ? "none" : input.motion,
				},
			},
		});
		return { operations: [operation], span, notes };
	}
	if (input.kind === "zoom")
		return {
			operations: [
				agentEditOperationSchema.parse({
					type: "addZoom",
					args: {
						startSec,
						endSec,
						customScale: ZOOM_SCALES[input.size],
						focus: anchorPosition(input.anchor),
						...SPEECH_MOTION[input.speed],
					},
				}),
			],
			span,
			notes,
		};
	if (input.kind === "camera")
		return {
			operations: [
				agentEditOperationSchema.parse({
					type: "addCameraFullscreen",
					args: {
						startSec,
						endSec,
						mode: input.mode === "full" ? "fullscreen" : "emphasis",
						cameraScale: CAMERA_EMPHASIS_SCALES[input.size],
						...SPEECH_MOTION.normal,
					},
				}),
			],
			span,
			notes,
		};
	const rect =
		input.fit === "cover"
			? null
			: overlayRect("broll", input.anchor, input.size, canvas, settings.safeMarginPercent);
	const asset = document.assets.find(
		(a) => path.resolve(a.originalPath) === path.resolve(input.file),
	);
	const args = {
		startSec,
		endSec,
		anchor,
		motion: input.motion,
		sourceOffsetSec: input.offset,
		fit: input.fit,
		placement: rect,
	};
	return asset
		? {
				operations: [
					agentEditOperationSchema.parse({
						type: "addVideoOverlay",
						args: { ...args, assetId: asset.id },
					}),
				],
				span,
				notes,
			}
		: {
				media: {
					kind: "video" as const,
					path: input.file,
					placement: {
						startSec,
						endSec,
						anchor,
						motion: input.motion,
						sourceOffsetSec: input.offset,
						fit: input.fit,
						position: rect ? { x: rect.x, y: rect.y } : undefined,
						size: rect ? { width: rect.width, height: rect.height } : undefined,
					},
				},
				span,
				notes,
			};
}

const responseSchema = z.looseObject({
	status: z.string(),
	data: z.record(z.string(), z.unknown()).optional(),
});
export async function applyPlacementCommand(
	input: PlacementIntent | ClipReplacementIntent | BrollSwapIntent,
	requestId: string,
	request: (r: AgentBrokerRequest) => Promise<unknown>,
	onPlan: (plan: Record<string, unknown>) => void,
) {
	const operationId = input.request_id ?? requestId;
	const ask = async (command: string, args: Record<string, unknown>, id: string = randomUUID()) =>
		responseSchema.parse(
			await request({ api_version: "1.0", request_id: id, command, input: args }),
		);
	const { kind, ...replacement } = input;
	const plan = await ask("plan", {
		projectId: input.project_id,
		...(kind === "clip"
			? { replacement }
			: kind === "broll-swap"
				? { swap: replacement }
				: { placement: input }),
	});
	if (plan.status !== "completed" || !plan.data) return plan;
	onPlan(plan.data);
	const planId = z.string().min(1).parse(plan.data.planId);
	let applied: z.infer<typeof responseSchema>;
	try {
		applied = await ask(
			"apply",
			{ projectId: input.project_id, planId, force: input.force },
			operationId,
		);
	} catch (error) {
		return {
			status: "recovery_required",
			operation_request_id: operationId,
			commit_status: "unknown",
			error: {
				code: "APPLY_OUTCOME_UNKNOWN",
				message: String(error),
				hint: unknownCommitRecoveryHint(operationId),
			},
		};
	}
	if (applied.status !== "completed")
		return {
			...applied,
			operation_request_id: operationId,
			data: { ...applied.data, plan: plan.data },
		};
	try {
		const state = await ask("state", {
			projectId: input.project_id,
			at: z.object({ startSec: z.number() }).parse(plan.data.span).startSec,
		});
		return {
			...state,
			operation_request_id: operationId,
			commit_status: "committed",
			data: {
				...state.data,
				...(plan.data.swap ? { swap: plan.data.swap } : {}),
				receipt: applied.data?.receipt,
				verify: applied.data?.verify,
				plan: plan.data,
			},
		};
	} catch (error) {
		return {
			status: "failed",
			operation_request_id: operationId,
			commit_status: "committed",
			data: {
				...(plan.data.swap ? { swap: plan.data.swap } : {}),
				receipt: applied.data?.receipt,
				verify: applied.data?.verify,
				plan: plan.data,
			},
			error: { code: "STATE_UNAVAILABLE", message: String(error) },
		};
	}
}

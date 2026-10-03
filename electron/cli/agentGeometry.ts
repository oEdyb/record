import { z } from "zod";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { assetCameraSource } from "../../src/lib/ai-edition/timeline/camera";
import { buildSceneDescription, resolveVisibleClips } from "../../src/native/sceneDescription";
import { CompositorViewService } from "../native-bridge/services/compositorViewService";

const number = z.number().finite();
const rect = z.object({
	x: number,
	y: number,
	width: number.nonnegative(),
	height: number.nonnegative(),
});
const pair = z.tuple([number, number]);
const responseSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("unavailable"),
		scope: z.literal("planned-composition"),
		reason: z.string(),
	}),
	z.object({
		status: z.literal("resolved"),
		scope: z.literal("planned-composition"),
		units: z.literal("output-pixels"),
		origin: z.literal("top-left"),
		clipIndex: z.number().int().nonnegative(),
		sourceTimeSec: number,
		evaluatedSourceTimeSec: number,
		output: z.object({ width: number.positive(), height: number.positive() }),
		screen: z.object({
			destination: rect,
			projectedCorners: z.tuple([pair, pair, pair, pair]),
			radiusPx: number,
			sourceUv: z.tuple([number, number, number, number]),
			rotation: z.tuple([number, number, number]),
		}),
		annotationContainer: rect,
		camera: z
			.object({ destination: rect, radiusPx: number, baseShape: z.string(), shapeFade: number })
			.nullable(),
		limitations: z.array(z.string()),
	}),
]);

const nativeService = new CompositorViewService();
type GeometryEvaluator = Pick<CompositorViewService, "evaluateSceneGeometry">;

function unavailable(reason: string) {
	return { status: "unavailable", scope: "planned-composition", reason } as const;
}

function dimensions(video: { width: number; height: number } | undefined) {
	return video &&
		[video.width, video.height].every((v) => Number.isInteger(v) && v > 0 && v <= 32768)
		? { width: video.width, height: video.height }
		: null;
}

function measure(bounds: z.infer<typeof rect>, output: { width: number; height: number }) {
	const right = bounds.x + bounds.width;
	const bottom = bounds.y + bounds.height;
	return {
		bounds,
		center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
		edgeDistances: {
			left: bounds.x,
			top: bounds.y,
			right: output.width - right,
			bottom: output.height - bottom,
		},
		canvasVisibility:
			bounds.width === 0 ||
			bounds.height === 0 ||
			right <= 0 ||
			bottom <= 0 ||
			bounds.x >= output.width ||
			bounds.y >= output.height
				? "outside"
				: bounds.x < 0 || bounds.y < 0 || right > output.width || bottom > output.height
					? "clipped"
					: "inside",
	};
}

/** clipIndex is the serialized visible scene segment index; time is in source seconds.
 * Uses stored dimensions or explicit path-matched camera probe evidence.
 * Surface boxes exclude shadows, masks and occlusion.
 * Camera metadata is currently available only if its file is also a document asset.
 */
export function evaluateAgentProjectGeometry(
	document: AxcutDocument,
	position: {
		clipIndex: number;
		sourceTimeSec: number;
		cameraEvidence?: { sourcePath: string; width: number; height: number };
	},
	evaluator: GeometryEvaluator = nativeService,
) {
	if (
		!Number.isInteger(position.clipIndex) ||
		position.clipIndex < 0 ||
		!Number.isFinite(position.sourceTimeSec) ||
		position.sourceTimeSec < 0
	) {
		throw new Error(
			"INVALID_GEOMETRY_POSITION: Expected a nonnegative scene clip index and source time.",
		);
	}
	const clip = resolveVisibleClips(document)[position.clipIndex];
	if (!clip) throw new Error("INVALID_GEOMETRY_POSITION: Scene clip index is out of range.");
	const asset = document.assets.find((candidate) => candidate.id === clip.assetId);
	const screenSize = dimensions(asset?.video);
	if (!screenSize) return unavailable("screen-dimensions-unavailable");
	const cameraPath = assetCameraSource(asset).path;
	const hasCamera = cameraPath !== "" && cameraPath !== asset?.originalPath;
	const cameraAsset = document.assets.find((candidate) => candidate.originalPath === cameraPath);
	const cameraEvidence =
		position.cameraEvidence?.sourcePath === cameraPath ? position.cameraEvidence : undefined;
	const webcamSize = hasCamera ? dimensions(cameraEvidence ?? cameraAsset?.video) : null;
	if (hasCamera && !webcamSize) return unavailable("camera-dimensions-unavailable");
	const scene = buildSceneDescription(document, webcamSize);
	const sceneClip = scene.clips[position.clipIndex];
	if (
		!sceneClip ||
		position.sourceTimeSec < sceneClip.sourceStartSec ||
		position.sourceTimeSec > sceneClip.sourceEndSec
	) {
		throw new Error("INVALID_GEOMETRY_POSITION: Source time is outside the scene clip.");
	}
	const json = evaluator.evaluateSceneGeometry(
		JSON.stringify({
			scene,
			clipIndex: position.clipIndex,
			sourceTimeSec: position.sourceTimeSec,
			screenSize: [screenSize.width, screenSize.height],
			webcamSize: webcamSize ? [webcamSize.width, webcamSize.height] : null,
		}),
	);
	if (json === null) return unavailable("native-geometry-query-unavailable");
	const result = responseSchema.parse(JSON.parse(json));
	if (result.status === "unavailable") return result;
	const xs = result.screen.projectedCorners.map(([x]) => x);
	const ys = result.screen.projectedCorners.map(([, y]) => y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return {
		...result,
		clipId: clip.id,
		assetId: clip.assetId,
		screen: {
			...result.screen,
			...measure({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, result.output),
		},
		camera: result.camera
			? { ...result.camera, ...measure(result.camera.destination, result.output) }
			: null,
	};
}

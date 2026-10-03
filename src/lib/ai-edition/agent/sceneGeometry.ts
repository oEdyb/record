import type { RenderRect } from "@/lib/compositeLayout";
import type { SceneDescription, SceneRect } from "@/native/sceneDescription";

export interface SceneGeometryPosition {
	/** Index in this serialized scene, not an index in the untrimmed project. */
	clipIndex: number;
	sourceTimeSec: number;
	editedTimeSec: number;
}

function finite(value: number, name: string): void {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function measureRect(rect: SceneRect, width: number, height: number) {
	for (const [key, value] of Object.entries(rect)) finite(value, `rectangle.${key}`);
	if (rect.width < 0 || rect.height < 0)
		throw new Error("Rectangle dimensions must be nonnegative");
	const bounds: RenderRect = {
		x: rect.x * width,
		y: rect.y * height,
		width: rect.width * width,
		height: rect.height * height,
	};
	const right = bounds.x + bounds.width;
	const bottom = bounds.y + bounds.height;
	const leftIntersection = Math.max(0, bounds.x);
	const topIntersection = Math.max(0, bounds.y);
	const intersectionWidth = Math.max(0, Math.min(width, right) - leftIntersection);
	const intersectionHeight = Math.max(0, Math.min(height, bottom) - topIntersection);
	const intersects = intersectionWidth > 0 && intersectionHeight > 0;
	return {
		bounds,
		center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
		/** Signed distances from the bounding box to each canvas edge; negative = overflow. */
		edgeDistances: { left: bounds.x, top: bounds.y, right: width - right, bottom: height - bottom },
		canvasIntersection: intersects
			? {
					x: leftIntersection,
					y: topIntersection,
					width: intersectionWidth,
					height: intersectionHeight,
				}
			: null,
		canvasVisibility: !intersects
			? ("outside" as const)
			: bounds.x < 0 || bounds.y < 0 || right > width || bottom > height
				? ("clipped" as const)
				: ("inside" as const),
	};
}

/**
 * Inspect the layout already resolved by buildSceneDescription/computeCompositeLayout.
 * This is deliberately NOT final-frame geometry. Native frame_geometry::plan_frame
 * transforms these boxes for zoom/reactive camera/camera regions, and the draw path
 * applies rotation, masks and occlusion. No second renderer is implemented here.
 *
 * Bounds exclude shadows and describe mask bounding boxes, not opaque pixel coverage.
 * Canvas intersection says nothing about occlusion or whether source media decoded.
 * The caller supplies both time domains from the authoritative playback mapping.
 */
export function inspectSceneBaseGeometry(scene: SceneDescription, position: SceneGeometryPosition) {
	const { width, height } = scene.output;
	finite(width, "output.width");
	finite(height, "output.height");
	if (width <= 0 || height <= 0) throw new Error("Output dimensions must be positive");
	finite(position.sourceTimeSec, "sourceTimeSec");
	finite(position.editedTimeSec, "editedTimeSec");
	if (position.sourceTimeSec < 0 || position.editedTimeSec < 0) {
		throw new Error("Times must be nonnegative");
	}
	if (!Number.isInteger(position.clipIndex) || !scene.clips[position.clipIndex]) {
		throw new Error("clipIndex must identify a clip in the serialized scene");
	}
	// An absent/null per-clip entry is unresolved. Using the first clip would invent
	// geometry when adjacent clips have different source dimensions or camera presence.
	const layout = scene.layout.layoutByClip
		? scene.layout.layoutByClip[position.clipIndex]
		: scene.layout;
	const screenRect = layout?.screenRect;
	const cameraRect = layout?.webcamRect;
	return {
		scope: "base-layout" as const,
		coordinateSpace: {
			units: "output-pixels" as const,
			origin: "top-left" as const,
			x: "right",
			y: "down",
		},
		output: { width, height },
		position: { ...position },
		finalFrame: {
			status: "unavailable" as const,
			reason:
				"Requires evaluated native compositor geometry; base bounds exclude animated transforms and occlusion.",
		},
		screen: screenRect
			? {
					status: "resolved" as const,
					...measureRect(screenRect, width, height),
					cover: layout.screenCover ?? false,
				}
			: { status: "unavailable" as const },
		camera: cameraRect
			? {
					status: "resolved" as const,
					...measureRect(cameraRect, width, height),
					maskShape: layout.webcamShape,
				}
			: cameraRect === null
				? { status: "absent" as const }
				: { status: "unavailable" as const },
		coverage:
			"Mask bounding boxes only; shadows, transparent corners, source availability and occlusion are not evaluated.",
	};
}

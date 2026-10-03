import { describe, expect, it } from "vitest";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { buildSceneDescription } from "@/native/sceneDescription";
import { inspectSceneBaseGeometry } from "./sceneGeometry";

function scene() {
	const document: AxcutDocument = {
		schemaVersion: axcutSchemaVersion,
		project: { id: "p", title: "Test", createdAt: "2026-09-07", updatedAt: "2026-09-07" },
		assets: [
			{ id: "a", kind: "video", label: "screen", originalPath: "/screen.mp4", cameraTrack: null },
		],
		timeline: {
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		transcript: null,
		transcripts: [],
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
	return buildSceneDescription(document);
}

const position = { clipIndex: 0, sourceTimeSec: 4, editedTimeSec: 2 };

describe("inspectSceneBaseGeometry", () => {
	it("reads the serializer's layout without claiming final painted geometry", () => {
		const input = scene();
		const result = inspectSceneBaseGeometry(input, position);
		const rect = input.layout.layoutByClip?.[0]?.screenRect;
		expect(rect).toBeTruthy();
		expect(result.screen).toMatchObject({
			status: "resolved",
			bounds: { x: (rect?.x ?? 0) * input.output.width },
		});
		expect(result.camera.status).toBe("absent");
		expect(result.scope).toBe("base-layout");
		expect(result.finalFrame.status).toBe("unavailable");
		expect(result.position).toEqual(position);
	});

	it("reports exact pixel edges and a circle's box, without rounding", () => {
		const input = scene();
		input.output = { width: 1000, height: 500, fps: 30 };
		input.layout.layoutByClip = [
			{
				screenRect: { x: 0, y: 0, width: 1, height: 1 },
				webcamRect: { x: 0.725, y: 0.5, width: 0.2, height: 0.4 },
				webcamShape: "circle",
				screenRadiusFrac: null,
				webcamRadiusFrac: 0.5,
				screenCover: false,
			},
		];
		expect(inspectSceneBaseGeometry(input, position).camera).toMatchObject({
			bounds: { x: 725, y: 250, width: 200, height: 200 },
			center: { x: 825, y: 350 },
			edgeDistances: { left: 725, top: 250, right: 75, bottom: 50 },
			canvasVisibility: "inside",
			maskShape: "circle",
		});
	});

	it("distinguishes clipping, no intersection and unresolved per-clip layouts", () => {
		const input = scene();
		const layout = input.layout.layoutByClip?.[0];
		if (!layout) throw new Error("Expected serializer layout");
		layout.screenRect = { x: -0.25, y: 0, width: 0.5, height: 1 };
		let result = inspectSceneBaseGeometry(input, position);
		expect(result.screen).toMatchObject({
			canvasVisibility: "clipped",
			canvasIntersection: { x: 0, width: input.output.width / 4 },
		});
		layout.screenRect.x = 1;
		result = inspectSceneBaseGeometry(input, position);
		expect(result.screen).toMatchObject({ canvasVisibility: "outside", canvasIntersection: null });
		input.layout.layoutByClip = [null];
		expect(inspectSceneBaseGeometry(input, position).screen.status).toBe("unavailable");
	});

	it("uses the selected per-clip layout, not the first clip's scalar layout", () => {
		const input = scene();
		input.clips.push({ ...input.clips[0] });
		const first = input.layout.layoutByClip?.[0];
		if (!first) throw new Error("Expected serializer layout");
		input.layout.layoutByClip = [
			first,
			{ ...first, screenRect: { x: 0.25, y: 0, width: 0.5, height: 1 } },
		];
		expect(inspectSceneBaseGeometry(input, { ...position, clipIndex: 1 }).screen).toMatchObject({
			bounds: { x: input.output.width / 4 },
		});
	});

	it("does not mutate scene or supplied time mapping", () => {
		const input = scene();
		const before = JSON.stringify(input);
		const result = inspectSceneBaseGeometry(input, position);
		result.position.editedTimeSec = 9;
		expect(position.editedTimeSec).toBe(2);
		expect(JSON.stringify(input)).toBe(before);
	});

	it("rejects invalid dimensions, time and clip selection", () => {
		const input = scene();
		expect(() =>
			inspectSceneBaseGeometry(input, { ...position, sourceTimeSec: Number.NaN }),
		).toThrow("finite");
		expect(() => inspectSceneBaseGeometry(input, { ...position, editedTimeSec: -1 })).toThrow(
			"nonnegative",
		);
		expect(() => inspectSceneBaseGeometry(input, { ...position, clipIndex: 4 })).toThrow(
			"clipIndex",
		);
		input.output.width = 0;
		expect(() => inspectSceneBaseGeometry(input, position)).toThrow("positive");
	});
});

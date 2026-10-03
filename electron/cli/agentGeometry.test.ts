import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { type AxcutDocument, axcutSchemaVersion } from "../../src/lib/ai-edition/schema";
import { CompositorViewService } from "../native-bridge/services/compositorViewService";
import { evaluateAgentProjectGeometry } from "./agentGeometry";

function document(): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: { id: "p", title: "Geometry", createdAt: "2026-09-07", updatedAt: "2026-09-07" },
		assets: [
			{
				id: "a",
				kind: "video",
				label: "Screen",
				originalPath: "/screen.mp4",
				video: { width: 1920, height: 1080, codec: "h264", fps: 30 },
				cameraTrack: null,
			},
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
}

const position = { clipIndex: 0, sourceTimeSec: 3 };
const unavailable = { evaluateSceneGeometry: vi.fn(() => null) };

describe("agent geometry evidence", () => {
	it("does not invent source or camera dimensions", () => {
		const input = document();
		input.assets[0].video = undefined;
		expect(evaluateAgentProjectGeometry(input, position, unavailable)).toMatchObject({
			reason: "screen-dimensions-unavailable",
		});
		input.assets[0].video = document().assets[0].video;
		input.assets[0].cameraTrack = {
			sourcePath: "/camera.mp4",
			startMs: 0,
			offsetMs: 0,
			visible: true,
		};
		expect(
			evaluateAgentProjectGeometry(
				input,
				{ ...position, cameraEvidence: { sourcePath: "/wrong.mp4", width: 1280, height: 720 } },
				unavailable,
			),
		).toMatchObject({ reason: "camera-dimensions-unavailable" });
	});
	it("passes only path-matched camera evidence and source coordinates to native planning", () => {
		const input = document();
		input.assets[0].cameraTrack = {
			sourcePath: "/camera.mp4",
			startMs: 0,
			offsetMs: 0,
			visible: true,
		};
		const evaluateSceneGeometry = vi.fn((_request: string) => null);
		evaluateAgentProjectGeometry(
			input,
			{ ...position, cameraEvidence: { sourcePath: "/camera.mp4", width: 1280, height: 720 } },
			{ evaluateSceneGeometry },
		);
		const request = JSON.parse(evaluateSceneGeometry.mock.calls[0][0]);
		expect(request).toMatchObject({
			clipIndex: 0,
			sourceTimeSec: 3,
			screenSize: [1920, 1080],
			webcamSize: [1280, 720],
		});
		expect(request.cameraEvidence).toBeUndefined();
	});
	it("rejects out-of-range time and reports an older addon explicitly", () => {
		expect(() =>
			evaluateAgentProjectGeometry(document(), { ...position, sourceTimeSec: 11 }, unavailable),
		).toThrow("outside");
		expect(evaluateAgentProjectGeometry(document(), position, unavailable)).toMatchObject({
			reason: "native-geometry-query-unavailable",
		});
	});
});

// No images or media are opened. This exercises the compiled pure planner on its target OS.
const macTest = process.platform === "darwin" ? it : it.skip;
macTest("reads native composed pixel bounds without creating a compositor view", () => {
	const addon = createRequire(import.meta.url)(
		"../native/compositor-view/build/compositor_view.node",
	);
	const service = new CompositorViewService({ addon });
	const result = evaluateAgentProjectGeometry(document(), position, service);
	expect(result.status).toBe("resolved");
	if (result.status !== "resolved") throw new Error("Expected native geometry");
	expect(result.screen.center.x).toBeCloseTo(result.output.width / 2);
	expect(result.screen.edgeDistances.left).toBeCloseTo(result.screen.edgeDistances.right);
	expect(result.camera).toBeNull();
	expect(result.clipId).toBe("c");
});

macTest("evaluates a real camera with explicit probed dimensions", () => {
	const addon = createRequire(import.meta.url)(
		"../native/compositor-view/build/compositor_view.node",
	);
	const input = document();
	input.assets[0].cameraTrack = {
		sourcePath: "/camera.mp4",
		startMs: 0,
		offsetMs: 0,
		visible: true,
	};
	const result = evaluateAgentProjectGeometry(
		input,
		{ ...position, cameraEvidence: { sourcePath: "/camera.mp4", width: 1280, height: 720 } },
		new CompositorViewService({ addon }),
	);
	expect(result.status).toBe("resolved");
	if (result.status !== "resolved") throw new Error("Expected native camera");
	expect(result.camera).not.toBeNull();
	expect(result.camera?.bounds.width).toBeGreaterThan(0);
	expect(result.camera?.center.x).toBeGreaterThan(0);
});

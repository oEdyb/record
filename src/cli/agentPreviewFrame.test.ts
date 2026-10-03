// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, documentSchema } from "@/lib/ai-edition/schema";
import { prepareAgentEditPlan } from "../../electron/ai-edition/agentEditPlan";

const bridge = vi.hoisted(() => ({
	createCompositorView: vi.fn(async () => ({ id: 7 })),
	destroyCompositorView: vi.fn(async () => ({ ok: true })),
	setCompositorScene: vi.fn(async () => ({ ok: true })),
	setCompositorParam: vi.fn(async () => ({ ok: true })),
	syncCompositorTransport: vi.fn(async () => ({ ok: true })),
	readCompositorFrame: vi.fn(),
}));
vi.mock("@/native/compositorViewClient", () => bridge);

import { captureAgentPreviewFrame, locateAgentPreviewFrame } from "./agentPreviewFrame";

function fixture() {
	return documentSchema.parse({
		...createEmptyDocument({ projectId: "preview", title: "Preview" }),
		assets: [
			{
				id: "a",
				kind: "video",
				label: "Screen",
				originalPath: "/screen.mp4",
				durationSec: 900,
				video: { width: 1920, height: 1080, fps: 30 },
				cameraTrack: { sourcePath: "/camera.mp4", offsetMs: 500 },
			},
		],
		timeline: {
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 840,
					timelineStartSec: 0,
					timelineEndSec: 840,
					origin: "user",
				},
			],
		},
		legacyEditor: { outputResolution: { width: 1280, height: 720 } },
	});
}
beforeEach(() => vi.clearAllMocks());
describe("native still frame selection", () => {
	it("seeks a late 14-minute frame with the complete scene", () => {
		const doc = prepareAgentEditPlan(fixture(), [
			{ type: "addZoom", args: { startSec: 830, endSec: 840 } },
		]).candidate;
		const result = locateAgentPreviewFrame(doc, 839.5);
		expect(result.sourceTimeSec).toBe(839.5);
		expect(result.clip.webcamOffsetSec).toBe(0.5);
		expect(result.scene.zoomRegions).toHaveLength(1);
		expect(result.scene.clips[0].sourceEndSec).toBe(840);
	});
	it("retains clip identity and source time after a trim and a speed region", () => {
		const doc = prepareAgentEditPlan(fixture(), [
			{ type: "addTrim", args: { clipId: "c", startSec: 10, endSec: 20 } },
		]).candidate;
		const result = locateAgentPreviewFrame(
			{
				...doc,
				legacyEditor: {
					...doc.legacyEditor,
					speedRegions: [{ id: "speed", startMs: 20000, endMs: 40000, speed: 2 }],
				},
			},
			15,
		);
		expect(result.clipIndex).toBe(1);
		expect(result.sourceTimeSec).toBe(30);
		expect(result.clip.sourceStartSec).toBe(20);
		expect(result.clip.webcamOffsetSec).toBe(0.5);
	});
	it("uses native per-span frame rounding at fractional clip boundaries", () => {
		const doc = fixture();
		const first = { ...doc.timeline.clips[0], sourceEndSec: 0.025, timelineEndSec: 0.025 };
		const second = {
			...first,
			id: "second",
			sourceStartSec: 1,
			sourceEndSec: 2,
			timelineStartSec: 0.025,
			timelineEndSec: 1.025,
		};
		const result = locateAgentPreviewFrame(
			{ ...doc, timeline: { ...doc.timeline, clips: [first, second] } },
			2 / 60,
		);
		expect(result.clipIndex).toBe(1);
		expect(result.sourceTimeSec).toBe(1);
	});
	it("rejects stale transport frames, renders one PNG and always releases the native view", async () => {
		const doc = fixture();
		const packet = {
			gen: 2,
			transportGeneration: 1,
			clipIndex: 0,
			sourceTimeSec: 839.5,
			width: 1280,
			height: 720,
			data: new Uint8Array(1280 * 720 * 4),
		};
		bridge.readCompositorFrame
			.mockResolvedValueOnce({ ...packet, transportGeneration: 0 })
			.mockResolvedValueOnce(packet);
		const putImageData = vi.fn();
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			putImageData,
		} as unknown as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
			"data:image/png;base64,eA==",
		);
		vi.stubGlobal(
			"ImageData",
			class {
				constructor(
					public data: Uint8ClampedArray,
					public width: number,
					public height: number,
				) {}
			},
		);
		expect(await captureAgentPreviewFrame(doc, 839.5)).toBe("data:image/png;base64,eA==");
		expect(bridge.readCompositorFrame).toHaveBeenCalledTimes(2);
		expect(bridge.syncCompositorTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				playing: false,
				sourceTimeSec: 839.5,
				clipIndex: 0,
				webcamOffsetSec: 0.5,
			}),
		);
		expect(bridge.setCompositorParam).toHaveBeenCalledWith(7, "previewSourceTimeSec", 839.5);
		expect(bridge.destroyCompositorView).toHaveBeenCalledWith(7);
		vi.unstubAllGlobals();
	});
	it("cleans up after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(captureAgentPreviewFrame(fixture(), 3, controller.signal)).rejects.toThrow(
			"cancelled",
		);
		expect(bridge.destroyCompositorView).toHaveBeenCalledWith(7);
	});
});

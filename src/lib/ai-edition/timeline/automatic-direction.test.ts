import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	applyAutomaticDirectionPlan,
	buildAutomaticDirectionPlan,
	DEFAULT_AUTOMATIC_DIRECTION_POLICY,
	regenerateAutomaticDirection,
	removeAutomaticDirection,
	resolveAutomaticDirectionPolicy,
} from "./automatic-direction";

function recordingDocument(): AxcutDocument {
	const base = createEmptyDocument({ title: "Direction", projectId: "direction-project" });
	return {
		...base,
		project: { ...base.project, primaryAssetId: "asset-1" },
		assets: [
			{
				id: "asset-1",
				kind: "video",
				label: "Recording",
				originalPath: "/tmp/recording.mp4",
				durationSec: 20,
				cameraTrack: {
					sourcePath: "/tmp/recording-camera.mp4",
					startMs: 0,
					offsetMs: 0,
					visible: true,
				},
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "system",
					reason: "Recorded clip",
				},
			],
		},
	};
}

describe("automatic direction plan", () => {
	it("keeps every behavior family on one independently tuneable policy", () => {
		const tuned = resolveAutomaticDirectionPolicy({
			screen: {
				defaultZoomDurationMs: 4_200,
				maxZoomsPerMinute: 7,
				clickEnvelopeFallbackScale: 1.1,
			},
			connectedClicks: { chainGapMs: 2_300 },
			typing: { typingIdleGapMs: 900 },
			microphoneActivity: { bridgeGapMs: 600, noiseQuantile: 0.35 },
			camera: { cameraScale: 1.55, maxPerMinute: 3, screenToCameraSpacingMs: 750 },
		});

		expect(tuned.screen.defaultZoomDurationMs).toBe(4_200);
		expect(tuned.screen.maxZoomsPerMinute).toBe(7);
		expect(tuned.screen.clickEnvelopeFallbackScale).toBe(1.1);
		expect(tuned.connectedClicks.chainGapMs).toBe(2_300);
		expect(tuned.typing.typingIdleGapMs).toBe(900);
		expect(tuned.microphoneActivity.bridgeGapMs).toBe(600);
		expect(tuned.microphoneActivity.noiseQuantile).toBe(0.35);
		expect(tuned.camera.cameraScale).toBe(1.55);
		expect(tuned.camera.maxPerMinute).toBe(3);
		expect(tuned.camera.screenToCameraSpacingMs).toBe(750);
		expect(DEFAULT_AUTOMATIC_DIRECTION_POLICY.screen.defaultZoomDurationMs).toBe(3_000);
	});

	it("caps every automatic screen scale override at 1.65x", () => {
		const tuned = resolveAutomaticDirectionPolicy({
			screen: {
				clickMinimumScale: 2.4,
				clickMaximumScale: 2.4,
				clickEnvelopeFallbackScale: 2.4,
				clickEnvelopeScaleSteps: [{ maximumSpan: 1, scale: 2.4 }],
				traceShortScale: 2.4,
				traceMediumScale: 2.4,
				traceLongScale: 2.4,
			},
			connectedClicks: { requestedScale: 2.4 },
		});

		expect(tuned.screen.clickMinimumScale).toBe(1.65);
		expect(tuned.screen.clickMaximumScale).toBe(1.65);
		expect(tuned.screen.clickEnvelopeFallbackScale).toBe(1.65);
		expect(tuned.screen.clickEnvelopeScaleSteps[0].scale).toBe(1.65);
		expect(tuned.screen.traceShortScale).toBe(1.65);
		expect(tuned.screen.traceMediumScale).toBe(1.65);
		expect(tuned.screen.traceLongScale).toBe(1.65);
		expect(tuned.connectedClicks.requestedScale).toBe(1.65);
	});

	it("plans screen and camera attention together as ordinary editable regions", () => {
		const document = recordingDocument();
		const cursorTelemetry = Array.from({ length: 81 }, (_, index) => ({
			timeMs: index * 250,
			cx: index === 40 ? 0.75 : 0.5,
			cy: 0.5,
			interactionType: index === 40 ? ("click" as const) : ("move" as const),
		}));
		const plan = buildAutomaticDirectionPlan({
			id: "recording-1",
			document,
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [{ startMs: 0, endMs: 4_000 }],
				},
			],
		});

		expect(plan.effects.some((effect) => effect.kind === "screen-zoom")).toBe(true);
		expect(plan.effects.some((effect) => effect.kind === "camera-emphasis")).toBe(true);

		const directed = applyAutomaticDirectionPlan(document, plan);
		expect(directed.zoomRanges).toHaveLength(1);
		const cameraRegions = (
			directed.legacyEditor as { cameraFullscreenRegions?: Array<Record<string, unknown>> }
		).cameraFullscreenRegions;
		expect(cameraRegions).toHaveLength(1);
		expect(cameraRegions?.[0]).toMatchObject({ mode: "emphasis", source: "auto" });

		// A retry applies the same stable plan without duplicating its regions.
		const retried = applyAutomaticDirectionPlan(directed, plan);
		expect(retried.zoomRanges).toHaveLength(1);
		expect(
			(retried.legacyEditor as { cameraFullscreenRegions?: Array<Record<string, unknown>> })
				.cameraFullscreenRegions,
		).toHaveLength(1);
	});

	it("reserves a quiet speech moment before later screen activity fills the shared budget", () => {
		const document = {
			...recordingDocument(),
			assets: [
				{
					...recordingDocument().assets[0],
					durationSec: 60,
				},
			],
			timeline: {
				...recordingDocument().timeline,
				clips: [
					{
						...recordingDocument().timeline.clips[0],
						sourceEndSec: 60,
						timelineEndSec: 60,
					},
				],
			},
		} as AxcutDocument;
		const clickTimes = [16_000, 25_000, 34_000, 43_000, 52_000];
		const cursorTelemetry = Array.from({ length: 241 }, (_, index) => {
			const timeMs = index * 250;
			const clickIndex = clickTimes.indexOf(timeMs);
			return {
				timeMs,
				cx: clickIndex >= 0 ? 0.2 + clickIndex * 0.15 : 0.5,
				cy: clickIndex % 2 === 0 ? 0.35 : 0.65,
				interactionType: clickIndex >= 0 ? ("click" as const) : ("move" as const),
			};
		});
		const plan = buildAutomaticDirectionPlan({
			id: "camera-priority",
			document,
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [{ startMs: 0, endMs: 10_000 }],
				},
			],
			policy: resolveAutomaticDirectionPolicy({
				screen: { maxZoomsPerMinute: 5 },
				camera: { maxTotalDirectionPerMinute: 5 },
			}),
		});

		expect(plan.effects.filter((effect) => effect.kind === "camera-emphasis")).toHaveLength(1);
		expect(plan.effects.filter((effect) => effect.kind === "screen-zoom")).toHaveLength(4);
	});

	it("does not let a new screen direction overlap an existing camera direction", () => {
		const document = recordingDocument();
		const withCamera = {
			...document,
			legacyEditor: {
				cameraFullscreenRegions: [
					{
						id: "manual-camera",
						startMs: 8_500,
						endMs: 12_000,
						mode: "emphasis",
						source: "manual",
					},
				],
			},
		} satisfies AxcutDocument;
		const plan = buildAutomaticDirectionPlan({
			id: "manual-screen",
			document: withCamera,
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry: [
						{ timeMs: 9_800, cx: 0.7, cy: 0.5, interactionType: "move" },
						{ timeMs: 10_000, cx: 0.7, cy: 0.5, interactionType: "click" },
						{ timeMs: 10_800, cx: 0.7, cy: 0.5, interactionType: "move" },
					],
				},
			],
			phases: { screen: true, camera: false },
		});

		expect(plan.effects).toEqual([]);
	});

	it("removes only automatic screen and camera direction", () => {
		const document = recordingDocument();
		const edited = {
			...document,
			zoomRanges: [
				{ id: "auto-zoom", startMs: 1_000, endMs: 4_000, depth: 3, source: "auto" },
				{ id: "manual-zoom", startMs: 8_000, endMs: 11_000, depth: 2, source: "manual" },
			],
			legacyEditor: {
				padding: 18,
				cameraFullscreenRegions: [
					{ id: "auto-camera", startMs: 0, endMs: 4_000, source: "auto" },
					{ id: "manual-camera", startMs: 12_000, endMs: 16_000, source: "manual" },
				],
			},
		} as AxcutDocument;

		const cleaned = removeAutomaticDirection(edited);

		expect(cleaned.zoomRanges.map((region) => region.id)).toEqual(["manual-zoom"]);
		expect(
			(
				cleaned.legacyEditor as { cameraFullscreenRegions: Array<{ id: string }> }
			).cameraFullscreenRegions.map((region) => region.id),
		).toEqual(["manual-camera"]);
		expect((cleaned.legacyEditor as { padding: number }).padding).toBe(18);
	});

	it("replaces the prior automatic plan without changing manual edits", () => {
		const document = recordingDocument();
		const previous = {
			...document,
			zoomRanges: [
				{ id: "old-auto", startMs: 1_000, endMs: 4_000, depth: 3, source: "auto" },
				{ id: "manual-zoom", startMs: 15_000, endMs: 18_000, depth: 2, source: "manual" },
			],
		} as AxcutDocument;

		const regenerated = regenerateAutomaticDirection({
			id: "regenerated-1",
			document: previous,
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry: [
						{ timeMs: 5_000, cx: 0.75, cy: 0.5, interactionType: "click" },
						{ timeMs: 5_400, cx: 0.75, cy: 0.5, interactionType: "move" },
					],
				},
			],
			policy: resolveAutomaticDirectionPolicy({ screen: { maxZoomsPerMinute: 10 } }),
		});

		expect(regenerated.zoomRanges.some((region) => region.id === "old-auto")).toBe(false);
		expect(regenerated.zoomRanges.some((region) => region.id === "manual-zoom")).toBe(true);
		expect(
			regenerated.zoomRanges.some((region) =>
				region.id.startsWith("auto-direction:regenerated-1:"),
			),
		).toBe(true);
	});
});

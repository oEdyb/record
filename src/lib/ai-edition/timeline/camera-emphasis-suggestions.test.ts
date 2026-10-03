import { describe, expect, it } from "vitest";
import { type AxcutClip, createEmptyDocument } from "../schema";
import {
	appendAutoCameraEmphasisSuggestions,
	buildAutoCameraEmphasisSuggestionsForTimeline,
	DEFAULT_CAMERA_EMPHASIS_POLICY,
} from "./camera-emphasis-suggestions";

const clip: AxcutClip = {
	id: "clip-1",
	assetId: "asset-1",
	sourceStartSec: 0,
	sourceEndSec: 10,
	timelineStartSec: 0,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "system",
	reason: "test",
};

function stationaryCursor() {
	return Array.from({ length: 41 }, (_, index) => ({
		timeMs: index * 250,
		cx: 0.8,
		cy: 0.7,
		interactionType: "move" as const,
	}));
}

function build(
	overrides: Partial<Parameters<typeof buildAutoCameraEmphasisSuggestionsForTimeline>[0]> = {},
) {
	return buildAutoCameraEmphasisSuggestionsForTimeline({
		recordings: [
			{
				assetId: "asset-1",
				microphoneActivity: [{ startMs: 0, endMs: 10_000 }],
				cursorTelemetry: stationaryCursor(),
			},
		],
		cameraAssetIds: new Set(["asset-1"]),
		clips: [clip],
		...overrides,
	});
}

describe("automatic camera emphasis", () => {
	it("uses sustained speech as confidence but anchors the result at speech onset", () => {
		expect(build()).toEqual([
			{
				span: { start: 0, end: 10_000 },
				automaticDirection: { version: 1, reason: "speech-with-quiet-screen" },
				mode: "emphasis",
				cameraScale: 1.35,
				source: "auto",
			},
		]);
	});

	it("adds a short quiet lead-in before speech detected later in the clip", () => {
		const result = build({
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 1_000, endMs: 10_000 }],
					cursorTelemetry: stationaryCursor(),
				},
			],
		});
		expect(result[0].span.start).toBe(750);
	});

	it("accepts speech that independently clears confidence and useful-duration thresholds", () => {
		expect(
			build({
				recordings: [
					{
						assetId: "asset-1",
						microphoneActivity: [{ startMs: 0, endMs: 4_000 }],
						cursorTelemetry: stationaryCursor(),
					},
				],
			}),
		).toHaveLength(1);
	});

	it.each([2_400, 3_400])("rejects a %d ms speech burst below a required threshold", (endMs) => {
		expect(
			build({
				recordings: [
					{
						assetId: "asset-1",
						microphoneActivity: [{ startMs: 0, endMs }],
						cursorTelemetry: stationaryCursor(),
					},
				],
			}),
		).toEqual([]);
	});

	it("does not extend the speech lead-in across the first cursor click", () => {
		const result = build({
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 1_000, endMs: 10_000 }],
					cursorTelemetry: [
						{ timeMs: 900, cx: 0.8, cy: 0.7, interactionType: "click" },
						...stationaryCursor().filter((sample) => sample.timeMs >= 1_000),
					],
				},
			],
		});

		expect(result[0].span.start).toBeGreaterThanOrEqual(2_500);
	});

	it("keeps the speech lead-in tunable through the camera policy", () => {
		const result = build({
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 1_000, endMs: 10_000 }],
					cursorTelemetry: stationaryCursor(),
				},
			],
			policy: { ...DEFAULT_CAMERA_EMPHASIS_POLICY, speechPreRollMs: 100 },
		});

		expect(result[0].span.start).toBe(900);
	});

	it("waits for the cursor to become quiet again after screen activity", () => {
		const moving = stationaryCursor().map((sample) =>
			sample.timeMs >= 2_750 && sample.timeMs <= 3_750
				? { ...sample, cx: 0.2 + (sample.timeMs - 2_750) / 2_500 }
				: sample,
		);
		const result = build({
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 0, endMs: 10_000 }],
					cursorTelemetry: moving,
				},
			],
		});
		expect(result).toHaveLength(1);
		expect(result[0].span.start).toBeGreaterThanOrEqual(5_000);
	});

	it("treats an opaque app-context change as screen activity", () => {
		const cursorTelemetry = stationaryCursor().map((sample) =>
			sample.timeMs === 3_000
				? { ...sample, directionContextChanged: true, directionExcluded: true }
				: sample,
		);
		const result = build({
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 0, endMs: 10_000 }],
					cursorTelemetry,
				},
			],
		});

		expect(result).toHaveLength(1);
		expect(result[0].span.start).toBeGreaterThanOrEqual(4_750);
	});

	it("treats typing as screen activity before Camera Emphasis", () => {
		const result = build({
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 0, endMs: 10_000 }],
					cursorTelemetry: stationaryCursor(),
					keyboardActivity: [
						{ timeMs: 1_000, cx: 0.5, cy: 0.5, count: 1 },
						{ timeMs: 2_000, cx: 0.5, cy: 0.5, count: 1 },
						{ timeMs: 3_000, cx: 0.5, cy: 0.5, count: 1 },
					],
				},
			],
		});

		expect(result).toHaveLength(1);
		expect(result[0].span.start).toBeGreaterThanOrEqual(4_500);
	});

	it("treats private typing as camera activity without using its focus", () => {
		const result = build({
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 0, endMs: 10_000 }],
					cursorTelemetry: stationaryCursor(),
					keyboardActivity: [
						{ timeMs: 1_000, cx: 0.5, cy: 0.5, count: 1, directionExcluded: true },
						{ timeMs: 2_000, cx: 0.5, cy: 0.5, count: 1, directionExcluded: true },
						{ timeMs: 3_000, cx: 0.5, cy: 0.5, count: 1, directionExcluded: true },
					],
				},
			],
		});

		expect(result).toHaveLength(1);
		expect(result[0].span.start).toBeGreaterThanOrEqual(4_500);
	});

	it("does nothing without a camera or when a screen zoom owns the moment", () => {
		expect(build({ cameraAssetIds: new Set() })).toEqual([]);
		expect(build({ occupiedScreenDirections: [{ start: 2_000, end: 10_000 }] })).toEqual([]);
	});

	it("allows a camera-to-screen handoff after speech without requiring a camera gap", () => {
		expect(build({ occupiedScreenDirections: [{ start: 11_000, end: 14_000 }] })).toHaveLength(1);
	});

	it("uses a short dedicated gap when Camera Emphasis follows a screen zoom", () => {
		const spacingPolicy = {
			...DEFAULT_CAMERA_EMPHASIS_POLICY,
			maxTotalDirectionPerMinute: 12,
		};
		const options = {
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 2_000, endMs: 10_000 }],
					cursorTelemetry: stationaryCursor(),
				},
			],
			policy: spacingPolicy,
		};

		expect(
			build({ ...options, occupiedScreenDirections: [{ start: 0, end: 1_000 }] }),
		).toHaveLength(1);
		expect(build({ ...options, occupiedScreenDirections: [{ start: 0, end: 1_500 }] })).toEqual([]);
		expect(
			build({
				...options,
				occupiedScreenDirections: [{ start: 0, end: 1_000 }],
				policy: { ...spacingPolicy, screenToCameraSpacingMs: 1_000 },
			}),
		).toEqual([]);
	});

	it("accepts the live screen-to-camera handoff after cursor activity becomes quiet", () => {
		const longClip = { ...clip, sourceEndSec: 52.85, timelineEndSec: 52.85 };
		const result = build({
			clips: [longClip],
			recordings: [
				{
					assetId: "asset-1",
					microphoneActivity: [{ startMs: 40_450, endMs: 51_150 }],
					cursorTelemetry: [
						{ timeMs: 0, cx: 0.67, cy: 0.38, interactionType: "move" },
						{ timeMs: 40_720, cx: 0.67, cy: 0.38, interactionType: "click" },
						{ timeMs: 52_850, cx: 0.67, cy: 0.38, interactionType: "move" },
					],
				},
			],
			occupiedScreenDirections: [{ start: 34_367, end: 41_532 }],
		});

		expect(result).toEqual([
			{
				span: { start: 42_250, end: 51_150 },
				automaticDirection: { version: 1, reason: "speech-with-quiet-screen" },
				mode: "emphasis",
				cameraScale: 1.35,
				source: "auto",
			},
		]);
	});

	it("does not assume the cursor was quiet when telemetry is missing", () => {
		expect(
			build({
				recordings: [
					{
						assetId: "asset-1",
						microphoneActivity: [{ startMs: 0, endMs: 10_000 }],
						cursorTelemetry: [],
					},
				],
			}),
		).toEqual([]);
	});

	it("counts existing camera regions against both camera and total motion budgets", () => {
		expect(
			build({
				existingCameraRegions: [
					{ startMs: 0, endMs: 1_000 },
					{ startMs: 11_000, endMs: 12_000 },
				],
				policy: {
					...DEFAULT_CAMERA_EMPHASIS_POLICY,
					maxPerMinute: 2,
					maxTotalDirectionPerMinute: 2,
				},
			}),
		).toEqual([]);
	});

	it("counts nearby connected screen targets as one total direction sequence", () => {
		const longClip = { ...clip, sourceEndSec: 60, timelineEndSec: 60 };
		const cursorTelemetry = Array.from({ length: 241 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		const result = build({
			clips: [longClip],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [{ startMs: 20_000, endMs: 30_000 }],
				},
			],
			occupiedScreenDirections: [
				{ start: 0, end: 4_000, directionGroupId: "one-screen-passage" },
				{ start: 4_500, end: 8_000, directionGroupId: "one-screen-passage" },
			],
			policy: {
				...DEFAULT_CAMERA_EMPHASIS_POLICY,
				maxTotalDirectionPerMinute: 2,
			},
		});

		expect(result).toHaveLength(1);
		expect(result[0].span).toEqual({ start: 19_750, end: 30_000 });
	});

	it("counts nearby different screen passages as separate total directions", () => {
		const longClip = { ...clip, sourceEndSec: 60, timelineEndSec: 60 };
		const cursorTelemetry = Array.from({ length: 241 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		const result = build({
			clips: [longClip],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [{ startMs: 20_000, endMs: 30_000 }],
				},
			],
			occupiedScreenDirections: [
				{ start: 0, end: 4_000, directionGroupId: "screen-a" },
				{ start: 4_500, end: 8_000, directionGroupId: "screen-b" },
			],
			policy: {
				...DEFAULT_CAMERA_EMPHASIS_POLICY,
				maxTotalDirectionPerMinute: 2,
			},
		});

		expect(result).toEqual([]);
	});

	it("counts touching screen and camera effects as separate modalities", () => {
		const longClip = { ...clip, sourceEndSec: 60, timelineEndSec: 60 };
		const cursorTelemetry = Array.from({ length: 241 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		const result = build({
			clips: [longClip],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [{ startMs: 20_000, endMs: 30_000 }],
				},
			],
			occupiedScreenDirections: [{ start: 0, end: 4_000, directionGroupId: "screen-a" }],
			existingCameraRegions: [{ startMs: 4_000, endMs: 8_000, directionGroupId: "camera-a" }],
			policy: {
				...DEFAULT_CAMERA_EMPHASIS_POLICY,
				maxTotalDirectionPerMinute: 2,
			},
		});

		expect(result).toEqual([]);
	});

	it("uses effect entrances for the rolling density window", () => {
		const longClip = { ...clip, sourceEndSec: 120, timelineEndSec: 120 };
		const result = build({
			clips: [longClip],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry: Array.from({ length: 481 }, (_, index) => ({
						timeMs: index * 250,
						cx: 0.8,
						cy: 0.7,
						interactionType: "move" as const,
					})),
					microphoneActivity: [{ startMs: 70_000, endMs: 80_000 }],
				},
			],
			existingCameraRegions: [{ startMs: 0, endMs: 50_000, directionGroupId: "camera-a" }],
			policy: {
				...DEFAULT_CAMERA_EMPHASIS_POLICY,
				maxTotalDirectionPerMinute: 1,
			},
		});

		expect(result).toHaveLength(1);
		expect(result[0].span).toEqual({ start: 69_750, end: 80_000 });
	});

	it("counts screen directions on opposite sides of a trim as separate sequences", () => {
		const longClip = { ...clip, sourceEndSec: 60, timelineEndSec: 60 };
		const cursorTelemetry = Array.from({ length: 241 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		const result = build({
			clips: [longClip],
			trimRanges: [
				{
					id: "trim-screen-gap",
					assetId: "asset-1",
					clipId: "clip-1",
					startSec: 4,
					endSec: 5,
					reason: "Removed",
					origin: "user",
				},
			],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [{ startMs: 20_000, endMs: 30_000 }],
				},
			],
			occupiedScreenDirections: [
				{ start: 0, end: 4_000 },
				{ start: 5_000, end: 8_000 },
			],
			policy: {
				...DEFAULT_CAMERA_EMPHASIS_POLICY,
				maxTotalDirectionPerMinute: 2,
			},
		});

		expect(result).toEqual([]);
	});

	it("leaves a visible quiet gap after an existing camera region", () => {
		const longClip = { ...clip, sourceEndSec: 60, timelineEndSec: 60 };
		const cursorTelemetry = Array.from({ length: 241 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		expect(
			build({
				clips: [longClip],
				recordings: [
					{
						assetId: "asset-1",
						cursorTelemetry,
						microphoneActivity: [{ startMs: 2_000, endMs: 10_000 }],
					},
				],
				existingCameraRegions: [{ startMs: 0, endMs: 1_000 }],
			}),
		).toEqual([]);
	});

	it("does not create two long camera effects with only a short gap", () => {
		const longClip = { ...clip, sourceEndSec: 60, timelineEndSec: 60 };
		const cursorTelemetry = Array.from({ length: 241 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		const result = build({
			clips: [longClip],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [
						{ startMs: 0, endMs: 10_000 },
						{ startMs: 11_000, endMs: 21_000 },
					],
				},
			],
		});

		expect(result).toHaveLength(1);
	});

	it("enforces the camera budget in every rolling minute", () => {
		const longClip = { ...clip, sourceEndSec: 120, timelineEndSec: 120 };
		const cursorTelemetry = Array.from({ length: 481 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		const result = build({
			clips: [longClip],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [
						{ startMs: 0, endMs: 10_000 },
						{ startMs: 15_000, endMs: 25_000 },
						{ startMs: 30_000, endMs: 40_000 },
						{ startMs: 65_000, endMs: 75_000 },
					],
				},
			],
		});
		expect(result.map((item) => item.span.start)).toEqual([0, 14_750, 64_750]);
	});

	it("enforces rolling budgets in trim-compressed playback time", () => {
		const longClip = { ...clip, sourceEndSec: 180, timelineEndSec: 180 };
		const cursorTelemetry = Array.from({ length: 721 }, (_, index) => ({
			timeMs: index * 250,
			cx: 0.8,
			cy: 0.7,
			interactionType: "move" as const,
		}));
		const result = build({
			clips: [longClip],
			trimRanges: [
				{
					id: "trim-1",
					assetId: "asset-1",
					clipId: "clip-1",
					startSec: 10,
					endSec: 60,
					reason: "Removed",
					origin: "user",
				},
				{
					id: "trim-2",
					assetId: "asset-1",
					clipId: "clip-1",
					startSec: 70,
					endSec: 120,
					reason: "Removed",
					origin: "user",
				},
			],
			recordings: [
				{
					assetId: "asset-1",
					cursorTelemetry,
					microphoneActivity: [
						{ startMs: 0, endMs: 10_000 },
						{ startMs: 60_000, endMs: 70_000 },
						{ startMs: 120_000, endMs: 130_000 },
					],
				},
			],
		});

		// The first two source ranges touch in playback, so the second is removed.
		// The third keeps a real ten-second visible gap and remains eligible.
		expect(result.map((item) => item.span.start)).toEqual([0, 120_000]);
	});

	it("does not count existing camera regions hidden by trims", () => {
		const longClip = { ...clip, sourceEndSec: 60, timelineEndSec: 60 };
		expect(
			build({
				clips: [longClip],
				trimRanges: [
					{
						id: "trim-1",
						assetId: "asset-1",
						clipId: "clip-1",
						startSec: 20,
						endSec: 60,
						reason: "Removed",
						origin: "user",
					},
				],
				existingCameraRegions: [{ startMs: 30_000, endMs: 32_000 }],
			}),
		).toHaveLength(1);
	});

	it("stores suggestions as normal clip-anchored editable regions", () => {
		const empty = createEmptyDocument({ title: "Camera", projectId: "camera-project" });
		const document = { ...empty, timeline: { ...empty.timeline, clips: [clip] } };
		const next = appendAutoCameraEmphasisSuggestions(document, build(), () => "camera-auto");
		const regions = (next.legacyEditor as { cameraFullscreenRegions: unknown[] })
			.cameraFullscreenRegions;
		expect(regions.at(-1)).toMatchObject({ motionStyle: "smooth", motionSpeed: 1 });
		expect(regions).toEqual([
			{
				id: "camera-auto",
				automaticDirection: { version: 1, reason: "speech-with-quiet-screen" },
				clipId: "clip-1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				startMs: 0,
				endMs: 10_000,
				mode: "emphasis",
				cameraScale: 1.35,
				source: "auto",
				motionStyle: "smooth",
				motionSpeed: 1,
			},
		]);
	});
});

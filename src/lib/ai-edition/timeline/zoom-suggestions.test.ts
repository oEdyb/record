import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type AxcutClip, createEmptyDocument } from "../schema";
import {
	appendAutoZoomSuggestions,
	buildAutoZoomSuggestions,
	buildAutoZoomSuggestionsForClips,
	buildAutoZoomSuggestionsForTimeline,
} from "./zoom-suggestions";

// A dwell = many samples clustered in time at (nearly) the same position.
function dwell(
	centerMs: number,
	cx: number,
	cy: number,
	count = 6,
	spanMs = 900,
): CursorTelemetryPoint[] {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
}

function clickAt(centerMs: number, cx: number, cy: number): CursorTelemetryPoint[] {
	const samples = dwell(centerMs, cx, cy);
	const middle = Math.floor(samples.length / 2);
	return samples.map((sample, index) =>
		index === middle ? { ...sample, interactionType: "click" as const } : sample,
	);
}

describe("buildAutoZoomSuggestions", () => {
	it("returns direction metadata around an accepted click", () => {
		const telemetry = clickAt(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toMatchObject({
			focusMode: "manual",
			customScale: 1.65,
			source: "auto",
		});
		expect(suggestions[0].span.start).toBeLessThan(2_000);
		expect(suggestions[0].span.end).toBeGreaterThan(2_000);
	});

	it("does not treat a normal mouse release as a second zoom target", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [
				{ timeMs: 1_500, cx: 0.4, cy: 0.5, interactionType: "move" },
				{ timeMs: 2_000, cx: 0.4, cy: 0.5, interactionType: "click" },
				{ timeMs: 2_080, cx: 0.4, cy: 0.5, interactionType: "mouseup" },
				{ timeMs: 3_000, cx: 0.4, cy: 0.5, interactionType: "move" },
			],
			totalMs: 5_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus).toEqual({ cx: 0.4, cy: 0.5 });
	});

	it("returns a connected sequence as ordinary timed zoom suggestions", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [
				{ timeMs: 2_000, cx: 0.75, cy: 0.45, interactionType: "click" },
				{ timeMs: 3_200, cx: 0.25, cy: 0.45, interactionType: "click" },
				{ timeMs: 4_400, cx: 0.75, cy: 0.55, interactionType: "click" },
			],
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions.length).toBeGreaterThan(1);
		expect(suggestions.every((suggestion) => suggestion.source === "auto")).toBe(true);
		expect(suggestions.every((suggestion) => suggestion.motionSpeed != null)).toBe(true);
		for (let index = 1; index < suggestions.length; index += 1) {
			expect(suggestions[index].span.start - suggestions[index - 1].span.end).toBeLessThanOrEqual(
				1_500,
			);
		}
	});

	it("uses sustained typing as the same ordinary auto Zoom activity", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: dwell(2_000, 0.55, 0.45, 20, 3_000),
			keyboardActivity: [
				{ timeMs: 1_200, cx: 0.55, cy: 0.45, count: 1 },
				{ timeMs: 1_500, cx: 0.56, cy: 0.45, count: 1 },
				{ timeMs: 1_800, cx: 0.57, cy: 0.45, count: 1 },
			],
			totalMs: 5_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toMatchObject({ focusMode: "manual", source: "auto" });
		expect(suggestions[0].span.start).toBeLessThan(1_200);
		expect(suggestions[0].span.end).toBeGreaterThan(1_800);
	});

	it("uses typing direction even when the cursor track is unavailable", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [],
			keyboardActivity: [
				{ timeMs: 1_200, cx: 0.75, cy: 0.45, count: 1 },
				{ timeMs: 1_500, cx: 0.75, cy: 0.45, count: 1 },
				{ timeMs: 1_800, cx: 0.75, cy: 0.45, count: 1 },
			],
			totalMs: 5_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		const halfViewport = 0.5 / suggestions[0].customScale;
		expect(suggestions[0].focus.cx - halfViewport).toBeLessThanOrEqual(0.75);
		expect(suggestions[0].focus.cx + halfViewport).toBeGreaterThanOrEqual(0.75);
	});

	it("extends a click into nearby typing instead of creating a second zoom", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [...clickAt(1_000, 0.5, 0.5), ...dwell(2_000, 0.5, 0.5, 8, 1_600)],
			keyboardActivity: [
				{ timeMs: 1_300, cx: 0.5, cy: 0.5, count: 1 },
				{ timeMs: 1_600, cx: 0.51, cy: 0.5, count: 1 },
				{ timeMs: 1_900, cx: 0.52, cy: 0.5, count: 1 },
			],
			totalMs: 5_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span.end).toBeGreaterThan(1_900);
	});

	it("keeps broad-target typing on its matching click instead of moving to the target center", () => {
		const targetRect = { x: 0.57, y: 0.08, width: 0.43, height: 0.84 };
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [
				{ timeMs: 5_000, cx: 0.777, cy: 0.876, interactionType: "move" },
				{ timeMs: 5_254, cx: 0.777, cy: 0.876, interactionType: "click" },
				{ timeMs: 10_500, cx: 0.777, cy: 0.876, interactionType: "move" },
			],
			keyboardActivity: [
				{ timeMs: 6_198, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 6_493, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 6_777, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 7_397, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 8_027, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 8_677, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 9_327, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 9_910, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
				{ timeMs: 10_157, cx: 0.785, cy: 0.5, count: 1, focusSource: "target", targetRect },
			],
			totalMs: 12_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions.every((suggestion) => suggestion.focus.cy > 0.6)).toBe(true);
		for (let index = 1; index < suggestions.length; index += 1) {
			expect(suggestions[index].span.start - suggestions[index - 1].span.end).toBeLessThanOrEqual(
				1_500,
			);
		}
		expect(suggestions.at(-1)!.span.end).toBeGreaterThan(10_157);
	});

	it("keeps a long same-target typing Zoom active until typing stops", () => {
		const targetRect = { x: 0.57, y: 0.08, width: 0.43, height: 0.84 };
		const keyboardActivity = Array.from({ length: 27 }, (_, index) => ({
			timeMs: 5_506 + index * 498,
			cx: 0.785,
			cy: 0.5,
			count: 1,
			focusSource: "target" as const,
			targetRect,
		}));
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [
				{ timeMs: 3_627, cx: 0.779, cy: 0.872, interactionType: "click" },
				{ timeMs: 4_225, cx: 0.779, cy: 0.872, interactionType: "click" },
				{ timeMs: 19_000, cx: 0.779, cy: 0.872, interactionType: "move" },
			],
			keyboardActivity,
			totalMs: 20_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions.length).toBeGreaterThan(0);
		for (let index = 1; index < suggestions.length; index += 1) {
			expect(suggestions[index].span.start - suggestions[index - 1].span.end).toBeLessThanOrEqual(
				1_500,
			);
		}
		expect(suggestions.at(-1)!.span.end).toBeGreaterThan(keyboardActivity.at(-1)!.timeMs);
	});

	it("drops candidates overlapping an existing zoom region", () => {
		const telemetry = clickAt(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [{ startMs: 1500, endMs: 2500 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(0);
	});

	it("spaces two clicks and returns both when the motion budget permits them", () => {
		const telemetry = [...clickAt(2000, 0.2, 0.2), ...clickAt(20_000, 0.8, 0.8)];
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 30_000,
			existingRegions: [],
			defaultDurationMs: 1500,
		});
		expect(suggestions.length).toBe(2);
	});

	it("does not mistake a passive dwell for user intent", () => {
		expect(
			buildAutoZoomSuggestions({
				cursorTelemetry: dwell(2_000, 0.5, 0.5),
				totalMs: 5_000,
				existingRegions: [],
				defaultDurationMs: 2_000,
			}),
		).toEqual([]);
	});

	it("returns nothing without telemetry", () => {
		expect(
			buildAutoZoomSuggestions({
				cursorTelemetry: [],
				totalMs: 5000,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});
});

describe("buildAutoZoomSuggestionsForClips", () => {
	const clip = (
		id: string,
		assetId: string,
		sourceStartSec: number,
		sourceEndSec: number,
		timelineStartSec: number,
	): AxcutClip => ({
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	});

	// The bug this covers: telemetry is in the recording's SOURCE time, zoom regions are
	// authored in RAW TIMELINE ms, and the two only coincide for a single clip starting at
	// 0. Every other layout put all the zooms on the first clip's stretch of ruler.
	it("gives an interaction to EVERY clip that replays it, not just the first", () => {
		// One recording, laid down twice: source 0-10 at ruler 0-10, then again at 10-20.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: clickAt(4000, 0.3, 0.7),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(2);
		expect(suggestions[1].span.start - suggestions[0].span.start).toBe(10_000);
		expect(suggestions[1].span.end - suggestions[0].span.end).toBe(10_000);
		for (const suggestion of suggestions) {
			expect(suggestion.focus.cx).toBeCloseTo(0.5 / 1.65, 5);
			expect(suggestion.focus.cy).toBeCloseTo(1 - 0.5 / 1.65, 5);
		}
	});

	it("budgets a connected click sequence separately for each replayed clip", () => {
		const clips = [
			clip("clip_1", "a1", 0, 10, 0),
			clip("clip_2", "a1", 0, 10, 10),
			clip("clip_3", "a1", 0, 10, 20),
		];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: [
				{ timeMs: 2_000, cx: 0.75, cy: 0.45, interactionType: "click" },
				{ timeMs: 3_200, cx: 0.25, cy: 0.45, interactionType: "click" },
			],
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		// Thirty seconds permits two sparse sequences. Replaying one source
		// three times must not collapse all three appearances into one group.
		expect(suggestions).toHaveLength(4);
		expect(suggestions.filter((suggestion) => suggestion.span.start < 10_000)).toHaveLength(2);
		expect(
			suggestions.filter(
				(suggestion) => suggestion.span.start >= 10_000 && suggestion.span.start < 20_000,
			),
		).toHaveLength(2);
	});

	it("shifts a dwell by the clip's own source in-point", () => {
		// A clip that starts 30s into the recording: source 34s is ruler 4s.
		const clips = [clip("clip_1", "a1", 30, 40, 0)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: clickAt(34000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span.start).toBeLessThan(4_000);
		expect(suggestions[0].span.end).toBeGreaterThan(4_000);
	});

	it("ignores a dwell that falls outside every clip's source window", () => {
		// The recording is long; the timeline keeps only its first 10s.
		const clips = [clip("clip_1", "a1", 0, 10, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: clickAt(45000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	it("reserves an existing zoom on the clip it actually sits on, and only there", () => {
		// A zoom already covers the dwell on clip_1's ruler span. clip_1 yields; clip_2
		// replays the same source moment on a free stretch of ruler, so it still gets one.
		// Compared in source ms — the frame the caller used to hand down — that one region
		// suppressed the whole recording's worth of suggestions.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: clickAt(4000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [{ startMs: 0, endMs: 10_000 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span.start).toBeGreaterThanOrEqual(10_000);
	});

	it("only reads the clips of the asset the telemetry belongs to", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: clickAt(4000, 0.5, 0.5),
			assetId: "a2",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span.start).toBeGreaterThanOrEqual(10_000);
	});

	it("skips a clip whose duration has not been probed yet", () => {
		const clips = [clip("clip_1", "a1", 0, 0, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: clickAt(4000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	it("applies one sparse motion budget across every short clip", () => {
		const clips = Array.from({ length: 12 }, (_, index) =>
			clip(`clip_${index}`, "a1", index * 5, index * 5 + 5, index * 5),
		);
		const cursorTelemetry = Array.from({ length: 12 }, (_, index) =>
			clickAt(index * 5_000 + 2_500, 0.15 + (index % 4) * 0.2, 0.5),
		).flat();
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [{ assetId: "a1", cursorTelemetry }],
			clips,
			existingRegions: [],
			defaultDurationMs: 2_000,
		});

		expect(suggestions).toHaveLength(4);
	});

	it("keeps exact-caret typing in the timeline path without cursor samples", () => {
		const clips = [clip("clip_1", "a1", 0, 5, 0)];
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: [],
					keyboardActivity: [
						{ timeMs: 1_200, cx: 0.75, cy: 0.45, count: 1, focusSource: "caret" },
						{ timeMs: 1_500, cx: 0.75, cy: 0.45, count: 1, focusSource: "caret" },
						{ timeMs: 1_800, cx: 0.75, cy: 0.45, count: 1, focusSource: "caret" },
					],
				},
			],
			clips,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		const halfViewport = 0.5 / suggestions[0].customScale;
		expect(suggestions[0].focus.cx - halfViewport).toBeLessThanOrEqual(0.75);
		expect(suggestions[0].focus.cx + halfViewport).toBeGreaterThanOrEqual(0.75);
	});

	it("does not spend the motion budget on interactions inside a trim", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0)];
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: [
						...clickAt(2_000, 0.2, 0.5),
						...clickAt(2_700, 0.21, 0.5),
						...clickAt(7_000, 0.8, 0.5),
					],
				},
			],
			clips,
			trimRanges: [
				{
					id: "trim_1",
					assetId: "a1",
					clipId: "clip_1",
					startSec: 0,
					endSec: 5,
					reason: "Removed",
					origin: "user",
				},
			],
			existingRegions: [],
			defaultDurationMs: 2_000,
		});

		expect(suggestions).toHaveLength(1);
		const halfViewport = 0.5 / suggestions[0].customScale;
		expect(suggestions[0].focus.cx).toBeLessThanOrEqual(0.8);
		expect(suggestions[0].focus.cx + halfViewport).toBeGreaterThanOrEqual(0.8);
		expect(suggestions[0].span.start).toBeGreaterThanOrEqual(5_000);
	});

	it("does not connect typing activity across a removed range", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0)];
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: Array.from({ length: 41 }, (_, index) => ({
						timeMs: index * 250,
						cx: 0.7,
						cy: 0.5,
					})),
					keyboardActivity: [
						{ timeMs: 1_000, cx: 0.3, cy: 0.5, count: 1 },
						{ timeMs: 1_300, cx: 0.3, cy: 0.5, count: 1 },
						{ timeMs: 1_600, cx: 0.3, cy: 0.5, count: 1 },
						{ timeMs: 6_500, cx: 0.7, cy: 0.5, count: 1 },
						{ timeMs: 6_800, cx: 0.7, cy: 0.5, count: 1 },
						{ timeMs: 7_100, cx: 0.7, cy: 0.5, count: 1 },
					],
				},
			],
			clips,
			trimRanges: [
				{
					id: "trim_1",
					assetId: "a1",
					clipId: "clip_1",
					startSec: 0,
					endSec: 5,
					reason: "Removed",
					origin: "user",
				},
			],
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span.start).toBeGreaterThanOrEqual(5_000);
	});

	it("budgets against kept duration and ignores an existing zoom hidden by a trim", () => {
		const clips = [clip("clip_1", "a1", 0, 60, 0)];
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: [2_000, 7_000, 12_000, 17_000].flatMap((timeMs) =>
						clickAt(timeMs, 0.2 + timeMs / 30_000, 0.5),
					),
				},
			],
			clips,
			trimRanges: [
				{
					id: "trim_1",
					assetId: "a1",
					clipId: "clip_1",
					startSec: 20,
					endSec: 60,
					reason: "Removed",
					origin: "user",
				},
			],
			existingRegions: [{ startMs: 30_000, endMs: 32_000 }],
			defaultDurationMs: 2_000,
		});

		expect(suggestions).toHaveLength(2);
	});

	it("connects nearby automatic zooms in trim-compressed playback time", () => {
		const clips = [clip("clip_1", "a1", 0, 40, 0)];
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: [...clickAt(4_400, 0.25, 0.5), ...clickAt(25_600, 0.75, 0.5)],
				},
			],
			clips,
			trimRanges: [
				{
					id: "trim_1",
					assetId: "a1",
					clipId: "clip_1",
					startSec: 5,
					endSec: 25,
					reason: "Removed",
					origin: "user",
				},
			],
			existingRegions: [],
			defaultDurationMs: 1_500,
		});

		// The clicks are far apart on the raw ruler, but only about 1.4 seconds
		// apart after the 20-second trim disappears from playback. That gap fits
		// the normal connected-pan window, so both intents stay in one visual
		// sequence instead of the second one disappearing.
		expect(suggestions).toHaveLength(2);
	});

	it("keeps qualified content around excluded cursor input in the timeline path", () => {
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: [
						{ timeMs: 0, cx: 0.9, cy: 0.5 },
						{ timeMs: 1_000, cx: 0.9, cy: 0.5, interactionType: "click" },
						{ timeMs: 1_600, cx: 0.9, cy: 0.5, interactionType: "click" },
						{ timeMs: 1_900, cx: 0.7, cy: 0.5, directionExcluded: true },
						{ timeMs: 3_600, cx: 0.75, cy: 0.5, interactionType: "click" },
						{ timeMs: 4_200, cx: 0.75, cy: 0.5, interactionType: "click" },
						{ timeMs: 5_500, cx: 0.75, cy: 0.5 },
					],
				},
			],
			clips: [clip("clip_1", "a1", 0, 6, 0)],
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus.cx).toBeGreaterThan(0.65);
		expect(suggestions[0].span.end).toBeGreaterThan(4_200);
	});

	it("keeps qualified typing around excluded keyboard input in the timeline path", () => {
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: [],
					keyboardActivity: [
						{ timeMs: 1_000, cx: 0.7, cy: 0.5, count: 1, focusSource: "caret" },
						{ timeMs: 1_300, cx: 0.7, cy: 0.5, count: 1, focusSource: "caret" },
						{ timeMs: 1_600, cx: 0.7, cy: 0.5, count: 1, focusSource: "caret" },
						{
							timeMs: 1_900,
							cx: 0.5,
							cy: 0.5,
							count: 1,
							focusSource: "caret",
							directionExcluded: true,
						},
						{ timeMs: 3_600, cx: 0.4, cy: 0.5, count: 1, focusSource: "caret" },
						{ timeMs: 3_900, cx: 0.4, cy: 0.5, count: 1, focusSource: "caret" },
						{ timeMs: 4_200, cx: 0.4, cy: 0.5, count: 1, focusSource: "caret" },
					],
				},
			],
			clips: [clip("clip_1", "a1", 0, 6, 0)],
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toHaveLength(1);
		const halfViewport = 0.5 / suggestions[0].customScale;
		expect(suggestions[0].focus.cx + halfViewport).toBeGreaterThanOrEqual(0.7);
		expect(suggestions[0].focus.cx - halfViewport).toBeLessThanOrEqual(0.4);
	});

	it("keeps a long cmux typing session after hovering over recorder UI", () => {
		const typingTimes = [
			31_824, 32_241, 32_399, 32_535, 32_668, 32_789, 32_926, 33_122, 33_335, 33_453, 33_576,
			33_821, 33_940, 34_058, 34_188, 34_308, 34_436, 34_556, 34_684, 34_807, 34_937, 35_058,
			35_183, 35_299, 35_421, 35_539, 35_655, 35_773, 35_907, 36_116, 36_270, 36_386, 36_506,
			36_719, 36_834, 36_959, 37_090, 37_224, 37_358, 37_484, 37_606, 37_732, 37_857, 38_059,
			38_186, 38_382, 38_655,
		];
		const targetRect = {
			x: 0.14035087719298245,
			y: 0.08130081300813008,
			width: 0.4295321637426901,
			height: 0.8373983739837398,
		};
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: [
						{ timeMs: 25_153, cx: 0.403, cy: 0.309, interactionType: "click" },
						{ timeMs: 26_137, cx: 0.452, cy: 0.677, interactionType: "click" },
						{ timeMs: 26_604, cx: 0.757, cy: 0.591, interactionType: "click" },
						{ timeMs: 27_627, cx: 0.768, cy: 0.301, interactionType: "click" },
						{ timeMs: 28_407, cx: 0.299, cy: 0.324, interactionType: "click" },
						{ timeMs: 29_209, cx: 0.385, cy: 0.71, interactionType: "click" },
						{ timeMs: 29_768, cx: 0.664, cy: 0.646, interactionType: "click" },
						{
							timeMs: 30_187,
							cx: 0.722,
							cy: 0.835,
							directionExcluded: true,
						},
						{
							timeMs: 30_304,
							cx: 0.34,
							cy: 0.891,
							directionExcluded: true,
						},
						{ timeMs: 30_874, cx: 0.186, cy: 0.866, interactionType: "click" },
					],
					keyboardActivity: typingTimes.map((timeMs) => ({
						timeMs,
						cx: 0.355,
						cy: 0.5,
						count: 1,
						focusSource: "target" as const,
						targetRect,
					})),
				},
			],
			clips: [clip("clip_1", "a1", 0, 54, 0)],
			existingRegions: [],
			defaultDurationMs: 3_000,
		});

		expect(typingTimes).toHaveLength(47);
		expect(suggestions.some((suggestion) => suggestion.span.start <= 29_768)).toBe(true);
		expect(suggestions.at(-1)!.span.start).toBeLessThan(31_824);
		expect(suggestions.at(-1)!.span.end).toBeGreaterThan(38_655);
		for (let index = 1; index < suggestions.length; index += 1) {
			expect(suggestions[index].span.start - suggestions[index - 1].span.end).toBeLessThanOrEqual(
				1_500,
			);
		}
	});

	it("leaves playback-time spacing after an existing zoom across a trim", () => {
		const suggestions = buildAutoZoomSuggestionsForTimeline({
			recordings: [
				{
					assetId: "a1",
					cursorTelemetry: clickAt(25_600, 0.75, 0.5),
				},
			],
			clips: [clip("clip_1", "a1", 0, 40, 0)],
			trimRanges: [
				{
					id: "trim_1",
					assetId: "a1",
					clipId: "clip_1",
					startSec: 5,
					endSec: 25,
					reason: "Removed",
					origin: "user",
				},
			],
			existingRegions: [{ startMs: 2_000, endMs: 4_000 }],
			defaultDurationMs: 3_000,
		});

		expect(suggestions).toEqual([]);
	});

	it("stores generated zooms as normal clip-anchored editable regions", () => {
		const document = createEmptyDocument({ title: "Test", projectId: "p1" });
		const withClip = {
			...document,
			timeline: { ...document.timeline, clips: [clip("clip_1", "a1", 0, 5, 0)] },
		};
		let id = 0;
		const next = appendAutoZoomSuggestions(
			withClip,
			[
				{
					span: { start: 1_000, end: 3_000 },
					focus: { cx: 0.3, cy: 0.7 },
					focusMode: "manual",
					customScale: 1.65,
					source: "auto",
				},
			],
			() => `zoom_${++id}`,
		);
		expect(next.zoomRanges.at(-1)).toMatchObject({ motionStyle: "smooth", motionSpeed: 1 });

		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({
			clipId: "clip_1",
			sourceStartSec: 1,
			sourceEndSec: 3,
			customScale: 1.65,
			focusMode: "manual",
			source: "auto",
		});
	});

	it("stores every connected target as a normal independently editable region", () => {
		const document = createEmptyDocument({ title: "Connected", projectId: "p-connected" });
		const withClip = {
			...document,
			timeline: { ...document.timeline, clips: [clip("clip_1", "a1", 0, 10, 0)] },
		};
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [
				{ timeMs: 2_000, cx: 0.75, cy: 0.45, interactionType: "click" },
				{ timeMs: 3_200, cx: 0.25, cy: 0.45, interactionType: "click" },
				{ timeMs: 4_400, cx: 0.75, cy: 0.55, interactionType: "click" },
			],
			totalMs: 10_000,
			existingRegions: [],
			defaultDurationMs: 3_000,
		});
		let id = 0;
		const next = appendAutoZoomSuggestions(withClip, suggestions, () => `connected_${++id}`);

		expect(next.zoomRanges).toHaveLength(suggestions.length);
		expect(new Set(next.zoomRanges.map((region) => region.id)).size).toBe(suggestions.length);
		expect(
			next.zoomRanges.every(
				(region) =>
					region.clipId === "clip_1" &&
					region.source === "auto" &&
					region.motionStyle === "smooth" &&
					region.motionSpeed != null,
			),
		).toBe(true);
	});
});

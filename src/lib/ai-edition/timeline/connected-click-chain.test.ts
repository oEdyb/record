import { describe, expect, it } from "vitest";
import { type ConnectedClickSample, planConnectedClickChains } from "./connected-click-chain";
import { DEFAULT_CONNECTED_CLICK_POLICY } from "./connected-click-policy";
import { buildDirectionPlan } from "./direction-engine";
import { buildDragFocusActivities } from "./drag-direction";

const sample = (
	timeMs: number,
	cx: number,
	cy: number,
	interactionType: string = "move",
	extra: Partial<ConnectedClickSample> = {},
): ConnectedClickSample => ({ timeMs, cx, cy, interactionType, visible: true, ...extra });

function pathThrough(points: Array<{ timeMs: number; cx: number; cy: number }>) {
	const samples: ConnectedClickSample[] = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const from = points[index];
		const to = points[index + 1];
		for (let timeMs = from.timeMs; timeMs < to.timeMs; timeMs += 50) {
			const progress = (timeMs - from.timeMs) / (to.timeMs - from.timeMs);
			samples.push(
				sample(
					timeMs,
					from.cx + (to.cx - from.cx) * progress,
					from.cy + (to.cy - from.cy) * progress,
				),
			);
		}
	}
	const last = points.at(-1)!;
	samples.push(sample(last.timeMs, last.cx, last.cy));
	return samples;
}

function clickPath() {
	const clicks = [
		{ timeMs: 2_000, cx: 0.75, cy: 0.45 },
		{ timeMs: 3_200, cx: 0.25, cy: 0.45 },
		{ timeMs: 4_400, cx: 0.75, cy: 0.55 },
		{ timeMs: 5_600, cx: 0.68, cy: 0.78 },
	];
	const samples = pathThrough([
		{ timeMs: 0, cx: 0.5, cy: 0.5 },
		...clicks,
		{ timeMs: 7_500, cx: 0.68, cy: 0.78 },
	]);
	for (const click of clicks) {
		const atClick = samples.find((entry) => entry.timeMs === click.timeMs)!;
		atClick.interactionType = "click";
	}
	return samples;
}

describe("connected click chain planner", () => {
	it("keeps the six-second detector split internal to one visual passage", () => {
		const clicks = [1_000, 2_700, 4_400, 6_100, 7_800, 9_500].map((timeMs, index) =>
			sample(timeMs, index % 2 === 0 ? 0.48 : 0.6, 0.5, "click"),
		);
		const plan = planConnectedClickChains({ cursor: clicks, durationMs: 12_000 });

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(plan.sequences[0].zooms).toHaveLength(1);
		expect(plan.sequences[0].resolvedScale).toBeCloseTo(1.65);
	});

	it("keeps an odd one-click detector tail inside its qualified visual passage", () => {
		const clicks = [1_000, 2_700, 4_400, 6_100, 7_800].map((timeMs, index) =>
			sample(timeMs, index % 2 === 0 ? 0.48 : 0.6, 0.5, "click"),
		);
		const plan = planConnectedClickChains({ cursor: clicks, durationMs: 10_000 });

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(plan.sequences[0].clickCount).toBe(5);
		expect(plan.sequences[0].zooms).toHaveLength(1);
		expect(plan.consumedSpans.at(-1)).toEqual({ start: 7_800, end: 7_800 });
	});

	it("simplifies overlapping detector chains into one safe visual passage", () => {
		const clickTimes = [1_000, 2_500, 4_000, 5_500, 6_500, 7_500, 8_500];
		const cursor = pathThrough([
			{ timeMs: 0, cx: 0.25, cy: 0.5 },
			...clickTimes.map((timeMs, index) => ({
				timeMs,
				cx: index % 2 === 0 ? 0.25 : 0.75,
				cy: 0.5,
			})),
			{ timeMs: 10_000, cx: 0.25, cy: 0.5 },
		]);
		for (const timeMs of clickTimes) {
			cursor.find((entry) => entry.timeMs === timeMs)!.interactionType = "click";
		}

		const plan = planConnectedClickChains({ cursor, durationMs: 11_000 });

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(plan.sequences[0].croppedFrames).toBe(0);
		expect(new Set(plan.sequences[0].zooms.map((zoom) => zoom.customScale)).size).toBe(1);
	});

	it("keeps the current focus when the six-second safeguard splits one visual passage", () => {
		const clickPoints = [
			{ timeMs: 1_000, cx: 0.5, cy: 0.5 },
			{ timeMs: 2_500, cx: 0.7, cy: 0.5 },
			{ timeMs: 4_000, cx: 0.92, cy: 0.5 },
			{ timeMs: 5_500, cx: 0.75, cy: 0.5 },
			{ timeMs: 6_500, cx: 0.75, cy: 0.5 },
			{ timeMs: 7_820, cx: 0.727, cy: 0.5 },
			{ timeMs: 8_720, cx: 0.813, cy: 0.5 },
		];
		const cursor = pathThrough([
			{ timeMs: 0, cx: 0.5, cy: 0.5 },
			...clickPoints,
			{ timeMs: 10_500, cx: 0.813, cy: 0.5 },
		]);
		for (const point of clickPoints) {
			cursor.find((entry) => entry.timeMs === point.timeMs)!.interactionType = "click";
		}

		const plan = planConnectedClickChains({ cursor, durationMs: 11_500 });

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(new Set(plan.sequences[0].zooms.map((zoom) => zoom.customScale)).size).toBe(1);
		expect(plan.sequences[0].zooms.at(-1)!.focus.cx).toBeGreaterThan(0.65);
	});

	it("adds pointer-path targets when a direct cross-chain pan would lose the pointer", () => {
		const clickTimes = [1_000, 2_100, 4_800, 5_900];
		const cursor = pathThrough([
			{ timeMs: 0, cx: 0.25, cy: 0.5 },
			{ timeMs: 1_000, cx: 0.25, cy: 0.5 },
			{ timeMs: 2_100, cx: 0.25, cy: 0.5 },
			{ timeMs: 3_400, cx: 0.25, cy: 0.5 },
			{ timeMs: 3_500, cx: 0.5, cy: 0.95 },
			{ timeMs: 4_000, cx: 0.75, cy: 0.5 },
			{ timeMs: 4_800, cx: 0.75, cy: 0.5 },
			{ timeMs: 5_900, cx: 0.75, cy: 0.5 },
			{ timeMs: 7_000, cx: 0.75, cy: 0.5 },
		]);
		for (const timeMs of clickTimes) {
			cursor.find((entry) => entry.timeMs === timeMs)!.interactionType = "click";
		}

		const plan = planConnectedClickChains({ cursor, durationMs: 8_000 });

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(plan.sequences[0].resolvedScale).toBeGreaterThanOrEqual(1.35);
		expect(plan.sequences[0].croppedFrames).toBe(0);
		expect(plan.sequences[0].zooms.length).toBeGreaterThan(2);
	});

	it("keeps an unusually broad passage safe without dropping its highlight drags", () => {
		const cursor = pathThrough([
			{ timeMs: 0, cx: 0.1, cy: 0.5 },
			{ timeMs: 1_000, cx: 0.1, cy: 0.5 },
			{ timeMs: 2_100, cx: 0.4, cy: 0.5 },
			{ timeMs: 3_400, cx: 0.4, cy: 0.5 },
			{ timeMs: 3_500, cx: 0.5, cy: 0.95 },
			{ timeMs: 4_000, cx: 0.9, cy: 0.5 },
			{ timeMs: 4_800, cx: 0.9, cy: 0.5 },
			{ timeMs: 5_900, cx: 0.6, cy: 0.5 },
			{ timeMs: 7_000, cx: 0.6, cy: 0.5 },
		]);
		for (const [timeMs, interactionType] of [
			[1_000, "click"],
			[2_100, "mouseup"],
			[4_800, "click"],
			[5_900, "mouseup"],
		] as const) {
			cursor.find((entry) => entry.timeMs === timeMs)!.interactionType = interactionType;
		}
		const policy = { ...DEFAULT_CONNECTED_CLICK_POLICY, passageMinimumStableScale: 1.5 };
		const focusActivities = buildDragFocusActivities(cursor, policy);
		const plan = planConnectedClickChains({ cursor, focusActivities, durationMs: 8_000, policy });

		expect(focusActivities).toHaveLength(4);
		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences.every((sequence) => sequence.containsDrag)).toBe(true);
		expect(plan.sequences.every((sequence) => sequence.resolvedScale >= 1.05)).toBe(true);
		expect(plan.sequences.every((sequence) => sequence.croppedFrames === 0)).toBe(true);
		for (const drag of [
			{ start: 1_000, end: 2_100 },
			{ start: 4_800, end: 5_900 },
		]) {
			expect(
				plan.sequences.some(
					(sequence) => sequence.span.start <= drag.start && sequence.span.end >= drag.end,
				),
			).toBe(true);
		}
	});

	it("centers a wide highlight at the deepest safe stable scale", () => {
		const cursor = Array.from({ length: 13 }, (_, index) =>
			sample(1_000 + index * 50, 0.1 + index * (0.7 / 12), 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(sample(3_000, 0.8, 0.5));
		const focusActivities = buildDragFocusActivities(cursor, DEFAULT_CONNECTED_CLICK_POLICY);

		const sequence = planConnectedClickChains({
			cursor,
			focusActivities,
			durationMs: 4_000,
		}).sequences[0];

		expect(sequence.zooms).toHaveLength(1);
		expect(sequence.zooms[0].focus.cx).toBeCloseTo(0.45, 5);
		expect(sequence.zooms[0].focus.cy).toBeCloseTo(0.5, 5);
		expect(sequence.resolvedScale).toBeGreaterThanOrEqual(
			DEFAULT_CONNECTED_CLICK_POLICY.minimumUsefulScale,
		);
		expect(sequence.resolvedScale).toBeLessThan(
			DEFAULT_CONNECTED_CLICK_POLICY.passageMinimumStableScale,
		);
		expect(sequence.croppedFrames).toBe(0);
	});

	it.each([
		[0.2, 0.5],
		[0.5, 0.2],
	])("centers a highlight region from %s to %s instead of favoring its press", (startX, endX) => {
		const cursor = Array.from({ length: 13 }, (_, index) =>
			sample(1_000 + index * 50, startX + (index * (endX - startX)) / 12, 0.6),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(sample(3_000, endX, 0.6));
		const focusActivities = buildDragFocusActivities(cursor, DEFAULT_CONNECTED_CLICK_POLICY);

		const sequence = planConnectedClickChains({
			cursor,
			focusActivities,
			durationMs: 4_000,
		}).sequences[0];

		expect(sequence.zooms[0].focus.cx).toBeCloseTo((startX + endX) / 2, 5);
		expect(sequence.zooms[0].focus.cy).toBeCloseTo(0.6, 5);
		expect(sequence.croppedFrames).toBe(0);
	});

	it("caps automatic connected Zooms at 1.65x", () => {
		const plan = planConnectedClickChains({
			cursor: clickPath(),
			durationMs: 8_000,
			policy: { ...DEFAULT_CONNECTED_CLICK_POLICY, requestedScale: 2.4 },
		});

		expect(plan.sequences).not.toHaveLength(0);
		expect(plan.sequences.every((sequence) => sequence.resolvedScale <= 1.65)).toBe(true);
	});

	it("never returns overlapping groups when a short target cannot fit a pan", () => {
		const clicks = [
			{ timeMs: 2_447, cx: 0.008981671882793307, cy: 0.4534586793743074 },
			{ timeMs: 3_654, cx: 0.2321054246276617, cy: 0.5179963314440101 },
			{ timeMs: 4_258, cx: 0.3102921622339636, cy: 0.29741046112030745 },
			{ timeMs: 5_257, cx: 0.8811190496198833, cy: 0.9221365090925246 },
			{ timeMs: 6_418, cx: 0.09547155327163637, cy: 0.02327744336798787 },
			{ timeMs: 7_078, cx: 0.02458814997226, cy: 0.8264005489181727 },
			{ timeMs: 8_370, cx: 0.33245752309449017, cy: 0.09469682909548283 },
			{ timeMs: 9_488, cx: 0.053729570005089045, cy: 0.448580693686381 },
			{ timeMs: 10_008, cx: 0.7866657103877515, cy: 0.9776511448435485 },
			{ timeMs: 10_519, cx: 0.36818038299679756, cy: 0.6880757173057646 },
		];
		const cursor = pathThrough([
			{ timeMs: 0, cx: 0.5, cy: 0.5 },
			...clicks,
			{ timeMs: 12_019, cx: 0.36818038299679756, cy: 0.6880757173057646 },
		]);
		for (const click of clicks) {
			cursor.find((entry) => entry.timeMs === click.timeMs)!.interactionType = "click";
		}

		const plan = planConnectedClickChains({ cursor, durationMs: 12_519 });

		for (let index = 1; index < plan.sequences.length; index += 1) {
			expect(plan.sequences[index - 1].span.end).toBeLessThanOrEqual(
				plan.sequences[index].span.start,
			);
		}
		expect(plan.sequences.reduce((score, sequence) => score + sequence.scoreWeight, 0)).toBe(10);
		expect(
			buildDirectionPlan({ cursor, durationMs: 12_519 }).zooms.reduce(
				(score, zoom) => score + zoom.score,
				0,
			),
		).toBeCloseTo(50);
	});

	it("does not let unrelated earlier typing disable later cross-chain pointer safety", () => {
		const clickTimes = [1_000, 2_100, 4_800, 5_900];
		const cursor = pathThrough([
			{ timeMs: 0, cx: 0.25, cy: 0.5 },
			{ timeMs: 1_000, cx: 0.25, cy: 0.5 },
			{ timeMs: 2_100, cx: 0.25, cy: 0.5 },
			{ timeMs: 3_400, cx: 0.25, cy: 0.5 },
			{ timeMs: 3_500, cx: 0.5, cy: 0.95 },
			{ timeMs: 4_000, cx: 0.75, cy: 0.5 },
			{ timeMs: 4_800, cx: 0.75, cy: 0.5 },
			{ timeMs: 5_900, cx: 0.75, cy: 0.5 },
			{ timeMs: 7_000, cx: 0.75, cy: 0.5 },
		]);
		for (const timeMs of clickTimes) {
			cursor.find((entry) => entry.timeMs === timeMs)!.interactionType = "click";
		}

		const plan = planConnectedClickChains({
			cursor,
			focusActivities: [
				sample(0, 0.25, 0.5, "typing", {
					directionActivityId: "typing-unrelated",
					directionWeight: 1,
				}),
			],
			durationMs: 8_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(plan.sequences[0].resolvedScale).toBeLessThan(1.65);
	});
	it("keeps a rapid right-left-right sequence zoomed and cursor-safe", () => {
		const plan = planConnectedClickChains({ cursor: clickPath(), durationMs: 8_000 });

		expect(plan.sequences).toHaveLength(1);
		const sequence = plan.sequences[0];
		expect(sequence.clickCount).toBe(4);
		expect(sequence.zooms.length).toBeGreaterThan(1);
		expect(sequence.croppedFrames).toBe(0);
		expect(sequence.zooms.every((zoom) => zoom.customScale === sequence.resolvedScale)).toBe(true);
		for (let index = 1; index < sequence.zooms.length; index += 1) {
			const previous = sequence.zooms[index - 1];
			const current = sequence.zooms[index];
			expect(current.span.start).toBeGreaterThan(previous.span.end);
			expect(current.span.start - previous.span.end).toBeLessThanOrEqual(1_500);
			expect([1.5, 2]).toContain(current.motionSpeed);
		}
	});

	it("uses one stable region when repeated clicks stay inside the dead zone", () => {
		const plan = planConnectedClickChains({
			cursor: [
				sample(1_000, 0.5, 0.5, "click"),
				sample(1_500, 0.51, 0.5),
				sample(2_000, 0.52, 0.51, "click"),
				sample(3_500, 0.52, 0.51),
			],
			durationMs: 4_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].zooms).toHaveLength(1);
		expect(plan.sequences[0].resolvedScale).toBeCloseTo(1.65);
	});

	it("leaves separate clicks to the normal single-click detector", () => {
		const plan = planConnectedClickChains({
			cursor: [sample(1_000, 0.2, 0.5, "click"), sample(3_000, 0.8, 0.5, "click")],
			durationMs: 5_000,
		});

		expect(plan).toEqual({ sequences: [], consumedSpans: [] });
	});

	it("keeps the deepest hard-visible scale when edge padding is impossible", () => {
		const cursor = Array.from({ length: 81 }, (_, index) =>
			sample(index * 50, 0.08, 0.08, index === 20 || index === 40 ? "click" : "move"),
		);
		const sequence = planConnectedClickChains({ cursor, durationMs: 4_000 }).sequences[0];

		expect(sequence.resolvedScale).toBeCloseTo(1.65);
		expect(sequence.croppedFrames).toBe(0);
		expect(sequence.paddedBreaches).toBeGreaterThan(0);
	});

	it("splits a click chain across a hidden cursor interval", () => {
		const plan = planConnectedClickChains({
			cursor: [
				sample(1_000, 0.2, 0.5, "click"),
				sample(1_400, 0.9, 0.5, "move", { visible: false }),
				sample(1_800, 0.9, 0.5, "move", { visible: false }),
				sample(2_000, 0.8, 0.5, "click"),
				sample(3_500, 0.8, 0.5),
			],
			durationMs: 4_000,
		});

		expect(plan).toEqual({ sequences: [], consumedSpans: [] });
	});

	it("reconciles qualified content chains around excluded cursor input", () => {
		const plan = planConnectedClickChains({
			cursor: [
				sample(0, 0.9, 0.5),
				sample(1_000, 0.9, 0.5, "click"),
				sample(1_600, 0.9, 0.5, "click"),
				sample(1_900, 0.7, 0.5, "move", { directionExcluded: true }),
				sample(2_200, 0.75, 0.5, "click"),
				sample(2_800, 0.75, 0.5, "click"),
				sample(4_000, 0.75, 0.5),
			],
			durationMs: 5_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(plan.sequences[0].clickCount).toBe(4);
		expect(plan.sequences[0].croppedFrames).toBe(0);
	});

	it("keeps custom pan speeds inside the production connection gap", () => {
		const sequence = planConnectedClickChains({
			cursor: clickPath(),
			durationMs: 8_000,
			policy: {
				...DEFAULT_CONNECTED_CLICK_POLICY,
				panMotionSpeeds: [0.5],
			},
		}).sequences[0];

		for (let index = 1; index < sequence.zooms.length; index += 1) {
			const previous = sequence.zooms[index - 1];
			const current = sequence.zooms[index];
			expect(current.motionSpeed).toBe(1);
			expect(current.span.start - previous.span.end).toBeLessThanOrEqual(1_500);
		}
	});

	it("checks short telemetry excursions even with a lower requested safety rate", () => {
		const sequence = planConnectedClickChains({
			cursor: [
				sample(0, 0.5, 0.5),
				sample(1_000, 0.5, 0.5, "click"),
				sample(1_500, 0.5, 0.5),
				sample(1_508, 0.82, 0.5),
				sample(1_516, 0.5, 0.5),
				sample(2_000, 0.5, 0.5, "click"),
				sample(3_000, 0.5, 0.5),
			],
			durationMs: 3_000,
			policy: {
				...DEFAULT_CONNECTED_CLICK_POLICY,
				safetyFramesPerSecond: 30,
			},
		}).sequences[0];

		expect(sequence.resolvedScale).toBeLessThan(1.65);
		expect(sequence.croppedFrames).toBe(0);
	});

	it("keeps the dead-zone choice injectable through one typed policy", () => {
		const cursor = clickPath();
		const wide = planConnectedClickChains({ cursor, durationMs: 8_000 }).sequences[0];
		const narrow = planConnectedClickChains({
			cursor,
			durationMs: 8_000,
			policy: {
				...DEFAULT_CONNECTED_CLICK_POLICY,
				deadZoneWidthRatio: 0.2,
				deadZoneHeightRatio: 0.2,
			},
		}).sequences[0];

		expect(narrow.zooms.length).toBeGreaterThanOrEqual(wide.zooms.length);
		expect(narrow.zooms.some((zoom, index) => zoom.focus.cx !== wide.zooms[index]?.focus.cx)).toBe(
			true,
		);
	});

	it("keeps passage simplification tunable through one typed policy", () => {
		const clicks = [1_000, 2_700, 4_400, 6_100, 7_800, 9_500].map((timeMs, index) =>
			sample(timeMs, index % 2 === 0 ? 0.5 : 0.68, 0.5, "click"),
		);
		const stable = planConnectedClickChains({ cursor: clicks, durationMs: 12_000 }).sequences[0];
		const deep = planConnectedClickChains({
			cursor: clicks,
			durationMs: 12_000,
			policy: {
				...DEFAULT_CONNECTED_CLICK_POLICY,
				passageMinimumStableScale: 1.5,
			},
		}).sequences[0];

		expect(stable.zooms.length).toBeLessThan(deep.zooms.length);
		expect(stable.resolvedScale).toBeLessThan(deep.resolvedScale);
		expect(new Set(stable.zooms.map((zoom) => zoom.customScale)).size).toBe(1);
	});

	it("reduces scale when a custom safe inset cannot contain the writing area", () => {
		const framingRect = { x: 0.27, y: 0.3, width: 0.46, height: 0.3 };
		const typing = [1_000, 1_300, 1_600].map((timeMs, index) => ({
			timeMs,
			cx: 0.5,
			cy: 0.45,
			interactionType: "typing",
			directionActivityId: "typing-wide-inset",
			directionWeight: index === 0 ? 1 : 0,
			framingRect,
		}));

		const sequence = planConnectedClickChains({
			cursor: [],
			focusActivities: typing,
			durationMs: 4_000,
			policy: { ...DEFAULT_CONNECTED_CLICK_POLICY, safeInset: 0.3 },
		}).sequences[0];

		expect(sequence.resolvedScale).toBeLessThan(DEFAULT_CONNECTED_CLICK_POLICY.requestedScale);
		expect(sequence.resolvedScale).toBeGreaterThanOrEqual(
			DEFAULT_CONNECTED_CLICK_POLICY.minimumUsefulScale,
		);
		expect(sequence.paddedBreaches).toBe(0);
	});

	it("uses typing anchors in the same connected sequence without moving the cursor track", () => {
		const cursor = pathThrough([
			{ timeMs: 0, cx: 0.45, cy: 0.5 },
			{ timeMs: 1_000, cx: 0.45, cy: 0.5 },
			{ timeMs: 4_000, cx: 0.45, cy: 0.5 },
		]);
		cursor.find((entry) => entry.timeMs === 1_000)!.interactionType = "click";
		const plan = planConnectedClickChains({
			cursor,
			focusActivities: [
				sample(1_300, 0.46, 0.5, "typing", { directionWeight: 1 }),
				sample(1_700, 0.48, 0.5, "typing", { directionWeight: 0 }),
			],
			durationMs: 4_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].scoreWeight).toBe(2);
		expect(plan.sequences[0].zooms).toHaveLength(1);
		expect(cursor.every((entry) => entry.cx === 0.45)).toBe(true);
	});

	it("frames the writing area without letting a parked pointer suppress the zoom", () => {
		const framingRect = { x: 0.58, y: 0.25, width: 0.4, height: 0.3 };
		const plan = planConnectedClickChains({
			cursor: [sample(0, 0.05, 0.9), sample(4_000, 0.05, 0.9)],
			focusActivities: [
				sample(1_000, 0.78, 0.4, "typing", { directionWeight: 1, framingRect }),
				sample(1_400, 0.78, 0.4, "typing", { directionWeight: 0, framingRect }),
			],
			durationMs: 4_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].resolvedScale).toBeCloseTo(1.65);
		expect(plan.sequences[0].croppedFrames).toBe(0);
		expect(plan.sequences[0].zooms[0].focus.cx).toBeGreaterThan(0.65);
		const focus = plan.sequences[0].zooms[0].focus;
		const safeHalf = (0.5 / plan.sequences[0].resolvedScale) * (1 - 0.18);
		expect(focus.cy - safeHalf).toBeLessThanOrEqual(framingRect.y);
		expect(focus.cy + safeHalf).toBeGreaterThanOrEqual(framingRect.y + framingRect.height);
	});

	it("holds the current frame when the next writing area already fits", () => {
		const left = { x: 0.35, y: 0.4, width: 0.1, height: 0.1 };
		const right = { x: 0.45, y: 0.4, width: 0.1, height: 0.1 };
		const plan = planConnectedClickChains({
			cursor: [],
			focusActivities: [
				sample(1_000, 0.4, 0.45, "typing", {
					directionActivityId: "typing-left",
					directionWeight: 1,
					framingRect: left,
				}),
				sample(1_300, 0.4, 0.45, "typing", {
					directionActivityId: "typing-left",
					directionWeight: 0,
					framingRect: left,
				}),
				sample(1_350, 0.5, 0.45, "typing", {
					directionActivityId: "typing-right",
					directionWeight: 1,
					framingRect: right,
				}),
				sample(1_650, 0.5, 0.45, "typing", {
					directionActivityId: "typing-right",
					directionWeight: 0,
					framingRect: right,
				}),
			],
			durationMs: 4_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
		expect(plan.sequences[0].zooms).toHaveLength(1);
		expect(plan.sequences[0].scoreWeight).toBe(2);
	});

	it("can plan typing when no raw cursor samples are available", () => {
		const plan = planConnectedClickChains({
			cursor: [],
			focusActivities: [
				sample(1_000, 0.5, 0.5, "typing", { directionWeight: 1 }),
				sample(1_400, 0.5, 0.5, "typing", { directionWeight: 0 }),
			],
			durationMs: 4_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].resolvedScale).toBeCloseTo(1.65);
	});

	it("renews one typing sequence beyond the click-chain duration limit", () => {
		const framingRect = { x: 0.57, y: 0.58, width: 0.4, height: 0.3 };
		const focusActivities = Array.from({ length: 27 }, (_, index) =>
			sample(1_000 + index * 500, 0.77, 0.73, "typing", {
				directionActivityId: "typing-1000",
				directionWeight: index === 0 ? 1 : 0,
				framingRect,
			}),
		);
		const plan = planConnectedClickChains({
			cursor: [sample(500, 0.77, 0.73, "click"), sample(15_000, 0.77, 0.73)],
			focusActivities,
			durationMs: 16_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].scoreWeight).toBe(2);
		expect(plan.sequences[0].span.end).toBeGreaterThan(focusActivities.at(-1)!.timeMs);
	});

	it("keeps the click-only duration limit as an internal detector safeguard", () => {
		const cursor = Array.from({ length: 9 }, (_, index) =>
			sample(1_000 + index * 1_000, 0.5, 0.5, "click"),
		);
		const plan = planConnectedClickChains({ cursor, durationMs: 11_000 });

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].detectorChainCount).toBe(2);
	});

	it("hands long typing directly to the next click", () => {
		const focusActivities = Array.from({ length: 27 }, (_, index) =>
			sample(1_000 + index * 500, 0.75, 0.7, "typing", {
				directionActivityId: "typing-1000",
				directionWeight: index === 0 ? 1 : 0,
			}),
		);
		const nextClickMs = 15_200;
		const plan = planConnectedClickChains({
			cursor: [
				sample(500, 0.75, 0.7, "click"),
				sample(nextClickMs, 0.3, 0.4, "click"),
				sample(16_500, 0.3, 0.4),
			],
			focusActivities,
			durationMs: 17_000,
		});

		expect(plan.sequences).toHaveLength(1);
		expect(plan.sequences[0].span.end).toBeGreaterThan(nextClickMs);
		expect(plan.sequences[0].scoreWeight).toBe(3);
	});
});

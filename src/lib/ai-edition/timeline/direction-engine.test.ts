import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECTED_CLICK_POLICY } from "./connected-click-policy";
import {
	buildDirectionPlan,
	DEFAULT_DIRECTION_POLICY,
	type DirectionCursorSample,
	detectClickDirectionCandidates,
	detectDirectionCandidates,
	detectTraceDirectionCandidates,
	normalizeDirectionCursor,
	selectDirectionCandidates,
} from "./direction-engine";

const point = (
	timeMs: number,
	cx: number,
	cy: number,
	interactionType: DirectionCursorSample["interactionType"] = "move",
	directionExcluded = false,
): DirectionCursorSample => ({
	timeMs,
	cx,
	cy,
	interactionType,
	...(directionExcluded ? { directionExcluded: true } : {}),
});

describe("automatic direction", () => {
	it("accepts eight well-spaced candidates within the default minute budget", () => {
		const candidates = Array.from({ length: 8 }, (_, index) => ({
			signal: "click" as const,
			span: { start: 2_000 + index * 7_000, end: 5_000 + index * 7_000 },
			focus: { cx: 0.5, cy: 0.5 },
			focusMode: "manual" as const,
			customScale: 1.65,
			score: 10,
		}));
		expect(selectDirectionCandidates({ candidates, durationMs: 60_000 })).toEqual(candidates);
	});

	it("turns a click and its settled cursor into one variable zoom", () => {
		const plan = buildDirectionPlan({
			cursor: [
				point(1_200, 0.2, 0.5),
				point(1_700, 0.48, 0.51),
				point(2_000, 0.5, 0.5, "click"),
				point(2_500, 0.501, 0.5),
				point(3_000, 0.5, 0.501),
			],
			durationMs: 5_000,
		});

		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0]).toMatchObject({
			signal: "click",
			focusMode: "manual",
			customScale: 1.65,
		});
		expect(plan.zooms[0].span.start).toBeLessThan(2_000);
		expect(plan.zooms[0].span.end).toBeGreaterThan(3_000);
	});

	it("groups nearby clicks and uses a gentler zoom for a wider interaction", () => {
		const candidates = detectClickDirectionCandidates({
			cursor: [
				point(1_000, 0.25, 0.5, "click"),
				point(1_700, 0.35, 0.5),
				point(2_100, 0.36, 0.5, "click"),
				point(2_800, 0.36, 0.5),
			],
			durationMs: 5_000,
			preferredZoomDurationMs: 2_000,
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0].span.end - candidates[0].span.start).toBeGreaterThan(2_000);
		expect(candidates[0].customScale).toBeLessThanOrEqual(1.65);
	});

	it("partitions one shallow passage into useful connected screen regions", () => {
		const cursor: DirectionCursorSample[] = [];
		for (let index = 0; index < 16; index++) {
			const timeMs = 1_000 + index * 900;
			const cx = index % 2 === 0 ? 0.25 : 0.75;
			const cy = index % 3 === 0 ? 0.7 : 0.3;
			cursor.push(
				point(timeMs, cx, cy, "click"),
				point(timeMs + 250, index % 2 === 0 ? 0.75 : 0.25, 0.5),
				point(timeMs + 500, cx, cy),
			);
		}

		const candidates = detectDirectionCandidates({
			cursor,
			durationMs: 16_000,
			preferredZoomDurationMs: 3_000,
		});

		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates.some((candidate) => candidate.sequenceId !== undefined)).toBe(true);
		expect(candidates.every((candidate) => candidate.customScale >= 1.35)).toBe(true);
		expect(candidates.every((candidate) => candidate.customScale <= 1.65)).toBe(true);
	});

	it("frames nearby typing activities as one passage without changing their total score", () => {
		const candidates = detectDirectionCandidates({
			cursor: [],
			focusActivities: [
				{
					timeMs: 1_000,
					cx: 0.5,
					cy: 0.5,
					interactionType: "typing",
					directionActivityId: "typing-a",
					directionWeight: 1,
				},
				{
					timeMs: 1_300,
					cx: 0.5,
					cy: 0.5,
					interactionType: "typing",
					directionActivityId: "typing-a",
					directionWeight: 0,
				},
				{
					timeMs: 1_350,
					cx: 0.52,
					cy: 0.5,
					interactionType: "typing",
					directionActivityId: "typing-b",
					directionWeight: 1,
				},
				{
					timeMs: 1_650,
					cx: 0.52,
					cy: 0.5,
					interactionType: "typing",
					directionActivityId: "typing-b",
					directionWeight: 0,
				},
			],
			durationMs: 5_000,
			preferredZoomDurationMs: 3_000,
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0].score).toBe(10);
	});

	it("holds a click zoom while attention stays on the selected area", () => {
		const cursor = [
			point(2_000, 0.5, 0.5, "click"),
			...Array.from({ length: 9 }, (_, index) =>
				point(2_500 + index * 500, 0.5 + (index % 2) * 0.001, 0.5),
			),
		];
		const candidates = detectClickDirectionCandidates({
			cursor,
			durationMs: 8_000,
			preferredZoomDurationMs: 3_000,
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0].span.end - candidates[0].span.start).toBeGreaterThanOrEqual(4_800);
	});

	it("fits one stable frame around the clicked area and the place the cursor settles next", () => {
		const candidates = detectClickDirectionCandidates({
			cursor: [
				point(1_000, 0.2, 0.42, "click"),
				point(1_100, 0.28, 0.43),
				point(1_200, 0.38, 0.44),
				point(1_300, 0.49, 0.45),
				...Array.from({ length: 10 }, (_, index) =>
					point(1_400 + index * 100, 0.58 + (index % 2) * 0.002, 0.46),
				),
			],
			durationMs: 5_000,
			preferredZoomDurationMs: 2_000,
		});

		expect(candidates).toHaveLength(1);
		const zoom = candidates[0];
		const halfViewport = 0.5 / zoom.customScale;
		expect(zoom.focus.cx - halfViewport).toBeLessThanOrEqual(0.2);
		expect(zoom.focus.cx + halfViewport).toBeGreaterThanOrEqual(0.582);
		expect(zoom.customScale).toBeLessThan(1.8);
	});

	it("ends a fixed click zoom before a later fast cursor fly-by", () => {
		const candidates = detectClickDirectionCandidates({
			cursor: [
				point(1_000, 0.5, 0.5, "click"),
				...Array.from({ length: 8 }, (_, index) => point(1_100 + index * 100, 0.5, 0.5)),
				point(1_950, 0.95, 0.1),
				...Array.from({ length: 8 }, (_, index) => point(2_000 + index * 100, 0.5, 0.5)),
			],
			durationMs: 5_000,
			preferredZoomDurationMs: 2_000,
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0].customScale).toBeGreaterThanOrEqual(1.35);
		expect(candidates[0].span.end).toBeLessThan(1_950);
	});

	it("rejects a fixed click zoom when the pointer moves outside its crop and parks there", () => {
		const candidates = detectClickDirectionCandidates({
			cursor: [
				point(1_000, 0.18, 0.5, "click"),
				point(1_100, 0.19, 0.5),
				point(1_200, 0.38, 0.5),
				point(1_300, 0.62, 0.5),
				...Array.from({ length: 12 }, (_, index) =>
					point(1_400 + index * 100, 0.9 + (index % 2) * 0.001, 0.5),
				),
			],
			durationMs: 5_000,
			preferredZoomDurationMs: 2_000,
		});

		expect(candidates).toEqual([]);
	});

	it("ends the real 25:43 bottom crop before the cursor leaves it", () => {
		const candidates = detectClickDirectionCandidates({
			cursor: [
				point(0, 0.314, 0.979, "click"),
				...Array.from({ length: 22 }, (_, index) => point(100 + index * 60, 0.314, 0.979)),
				point(1_350, 0.613, 0.883),
				point(1_450, 0.683, 0.835),
				point(1_550, 0.758, 0.796),
				...Array.from({ length: 7 }, (_, index) => point(1_650 + index * 100, 0.782, 0.79)),
				point(2_450, 0.607, 0.419),
				point(2_650, 0.588, 0.02),
				point(3_500, 0.592, 0.019),
			],
			durationMs: 6_000,
			preferredZoomDurationMs: 3_000,
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0].customScale).toBe(1.65);
		expect(candidates[0].span.end).toBeLessThan(1_350);
	});

	it("ends an earlier fixed crop safely without absorbing the next separate click", () => {
		const cursor = [
			point(1_000, 0.2, 0.5, "click"),
			...Array.from({ length: 8 }, (_, index) => point(1_100 + index * 100, 0.2, 0.5)),
			point(1_900, 0.35, 0.5),
			point(2_000, 0.5, 0.5),
			point(2_100, 0.72, 0.5),
			point(2_200, 0.75, 0.5),
			point(2_300, 0.75, 0.5),
			point(2_400, 0.75, 0.5),
			point(2_500, 0.75, 0.5, "click"),
			point(2_800, 0.75, 0.5),
		];
		const candidates = detectClickDirectionCandidates({
			cursor,
			durationMs: 6_000,
			preferredZoomDurationMs: 2_000,
		});

		expect(candidates).toHaveLength(2);
		expect(candidates[0].customScale).toBeGreaterThanOrEqual(1.35);
		expect(candidates[0].span.end).toBeLessThan(candidates[1].span.start);
		const halfViewport = 0.5 / candidates[1].customScale;
		expect(candidates[1].focus.cx - halfViewport).toBeLessThanOrEqual(0.75);
		expect(candidates[1].focus.cx + halfViewport).toBeGreaterThanOrEqual(0.75);

		const connected = detectDirectionCandidates({
			cursor,
			durationMs: 6_000,
			preferredZoomDurationMs: 2_000,
		});
		expect(connected).toHaveLength(2);
		expect(new Set(connected.map((candidate) => candidate.sequenceId)).size).toBe(1);
	});

	it("does not use clicks on private recording UI for automatic direction", () => {
		const plan = buildDirectionPlan({
			cursor: [point(1_000, 0.55, 0.86, "click", true), point(1_400, 0.55, 0.86, "move", true)],
			durationMs: 4_000,
		});

		expect(plan.zooms).toEqual([]);
	});

	it("keeps qualified content on both sides of excluded cursor input", () => {
		const plan = buildDirectionPlan({
			cursor: [
				point(0, 0.9, 0.5),
				point(1_000, 0.9, 0.5, "click"),
				point(1_600, 0.9, 0.5, "click"),
				point(1_900, 0.7, 0.5, "move", true),
				point(2_200, 0.75, 0.5, "click"),
				point(2_800, 0.75, 0.5, "click"),
				point(4_000, 0.75, 0.5),
			],
			durationMs: 5_000,
		});

		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0].score).toBe(20);
		expect(plan.zooms[0].focus.cx).toBeGreaterThan(0.65);
	});

	it("uses the normal short handoff around excluded cursor input", () => {
		const plan = buildDirectionPlan({
			cursor: [
				point(0, 0.9, 0.5),
				point(1_000, 0.9, 0.5, "click"),
				point(1_600, 0.9, 0.5, "click"),
				point(1_900, 0.7, 0.5, "move", true),
				point(3_600, 0.75, 0.5, "click"),
				point(4_200, 0.75, 0.5, "click"),
				point(5_500, 0.75, 0.5),
			],
			durationMs: 6_000,
		});

		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0].span.start).toBeLessThan(1_000);
		expect(plan.zooms[0].span.end).toBeGreaterThan(4_200);
	});

	it("keeps qualified typing sessions around an excluded focus sample", () => {
		const typing = (
			timeMs: number,
			activityId: string,
			weight: number,
			directionExcluded = false,
		): DirectionCursorSample => ({
			timeMs,
			cx: activityId === "typing-a" ? 0.7 : 0.4,
			cy: 0.5,
			interactionType: "typing",
			directionActivityId: activityId,
			directionWeight: weight,
			...(directionExcluded ? { directionExcluded: true } : {}),
		});
		const plan = buildDirectionPlan({
			cursor: [],
			focusActivities: [
				typing(1_000, "typing-a", 1),
				typing(1_600, "typing-a", 0),
				typing(1_900, "private", 0, true),
				typing(3_600, "typing-b", 1),
				typing(4_200, "typing-b", 0),
			],
			durationMs: 6_000,
		});

		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0].score).toBe(10);
		expect(plan.zooms[0].focus.cx).toBeCloseTo(0.55, 1);
	});

	it("keeps movement strength tunable through one direction policy", () => {
		const candidates = detectClickDirectionCandidates({
			cursor: [point(1_000, 0.5, 0.5, "click"), point(1_800, 0.5, 0.5)],
			durationMs: 4_000,
			preferredZoomDurationMs: 2_000,
			policy: { ...DEFAULT_DIRECTION_POLICY, clickMaximumScale: 1.4 },
		});

		expect(candidates[0].customScale).toBe(1.4);
	});

	it("keeps the minimum duration tunable through the direction policy", () => {
		const plan = buildDirectionPlan({
			cursor: [point(1_000, 0.5, 0.5, "click"), point(1_800, 0.5, 0.5)],
			durationMs: 3_000,
			policy: { ...DEFAULT_DIRECTION_POLICY, minimumZoomDurationMs: 3_500 },
		});

		expect(plan.zooms).toEqual([]);
	});

	it("recognizes a deliberate cursor trace that settles without a click", () => {
		const cursor: DirectionCursorSample[] = [];
		for (let index = 0; index <= 10; index += 1) {
			cursor.push(point(1_000 + index * 120, 0.2 + index * 0.02, 0.45));
		}
		cursor.push(point(2_400, 0.4, 0.45), point(2_600, 0.4, 0.45), point(2_800, 0.4, 0.45));

		const candidates = detectTraceDirectionCandidates({
			cursor,
			durationMs: 5_000,
			preferredZoomDurationMs: 2_000,
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ signal: "trace", focusMode: "auto" });
		expect(candidates[0].focus.cx).toBeCloseTo(0.4);
	});

	it("rejects ordinary movement followed by a telemetry gap instead of a real settle", () => {
		const cursor = [
			point(1_000, 0.2, 0.45),
			point(1_800, 0.3, 0.45),
			point(2_600, 0.4, 0.45),
			point(5_000, 0.4, 0.45),
		];
		expect(
			detectTraceDirectionCandidates({
				cursor,
				durationMs: 6_000,
				preferredZoomDurationMs: 2_000,
			}),
		).toEqual([]);
	});

	it("does not turn a stationary cursor into a zoom", () => {
		const cursor = Array.from({ length: 20 }, (_, index) => point(index * 100, 0.5, 0.5));
		expect(buildDirectionPlan({ cursor, durationMs: 4_000 }).zooms).toEqual([]);
	});

	it("accepts eight well-spaced click zooms with the default safety budget", () => {
		const cursor: DirectionCursorSample[] = [];
		for (let index = 0; index < 8; index += 1) {
			const time = 2_000 + index * 7_000;
			cursor.push(point(time, 0.15 + (index % 4) * 0.2, 0.5, "click"));
			cursor.push(point(time + 700, 0.15 + (index % 4) * 0.2, 0.5));
		}

		const plan = buildDirectionPlan({ cursor, durationMs: 60_000 });

		expect(plan.zooms).toHaveLength(8);
		expect(plan.zooms.every((zoom) => zoom.signal === "click")).toBe(true);
	});

	it("leaves occupied manual zoom spans untouched", () => {
		const plan = buildDirectionPlan({
			cursor: [point(2_000, 0.5, 0.5, "click"), point(2_800, 0.5, 0.5)],
			durationMs: 5_000,
			occupiedZooms: [{ start: 1_000, end: 4_000 }],
		});
		expect(plan.zooms).toEqual([]);
	});

	it("leaves a quiet gap after an occupied zoom", () => {
		const plan = buildDirectionPlan({
			cursor: [point(5_000, 0.5, 0.5, "click"), point(5_800, 0.5, 0.5)],
			durationMs: 60_000,
			occupiedZooms: [{ start: 1_000, end: 4_000 }],
		});

		expect(plan.zooms).toEqual([]);
	});

	it("does not create a zoom shorter than the policy minimum", () => {
		const plan = buildDirectionPlan({
			cursor: [point(1_000, 0.5, 0.5, "click"), point(1_800, 0.5, 0.5)],
			durationMs: 2_600,
		});

		expect(plan.zooms).toEqual([]);
	});

	it("counts existing zoom sequences against the project motion budget", () => {
		const plan = buildDirectionPlan({
			cursor: [point(55_000, 0.5, 0.5, "click")],
			durationMs: 60_000,
			occupiedZooms: Array.from({ length: 12 }, (_, index) => ({
				start: 1_000 + index * 4_000,
				end: 3_000 + index * 4_000,
			})),
		});
		expect(plan.zooms).toEqual([]);
	});

	it("drops out-of-range events instead of clamping them onto a clip edge", () => {
		const plan = buildDirectionPlan({
			cursor: [point(6_000, 0.8, 0.2, "click")],
			durationMs: 5_000,
		});
		expect(plan.zooms).toEqual([]);
	});

	it("does not squeeze a zoom into a clip too short for the movement", () => {
		const plan = buildDirectionPlan({
			cursor: [point(500, 0.5, 0.5, "click")],
			durationMs: 1_000,
		});
		expect(plan.zooms).toEqual([]);
	});

	it("handles long recordings without scanning the full stream for every click", () => {
		const cursor = Array.from({ length: 50_000 }, (_, index) =>
			point(index * 10, 0.55, 0.45, index === 25_000 ? "click" : "move"),
		);
		const plan = buildDirectionPlan({ cursor, durationMs: 500_000 });
		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0].focus).toEqual({ cx: 0.55, cy: 0.45 });
	});

	it("counts one connected click chain as one sparse direction sequence", () => {
		const plan = buildDirectionPlan({
			cursor: [
				point(2_000, 0.75, 0.45, "click"),
				point(3_200, 0.25, 0.45, "click"),
				point(4_400, 0.75, 0.55, "click"),
			],
			durationMs: 10_000,
		});

		expect(plan.zooms.length).toBeGreaterThan(1);
		expect(new Set(plan.zooms.map((zoom) => zoom.sequenceId)).size).toBe(1);
		expect(plan.zooms.every((zoom) => zoom.customScale >= 1.05)).toBe(true);
	});

	it("rejects a whole connected chain when a manual zoom occupies its sequence span", () => {
		const plan = buildDirectionPlan({
			cursor: [
				point(2_000, 0.75, 0.45, "click"),
				point(3_200, 0.25, 0.45, "click"),
				point(4_400, 0.75, 0.55, "click"),
			],
			durationMs: 10_000,
			occupiedZooms: [{ start: 3_000, end: 3_500 }],
		});

		expect(plan.zooms).toEqual([]);
	});

	it("keeps a nearby automatic intent as one connected visual sequence", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 1_000, end: 4_000 },
					focus: { cx: 0.25, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
					intentSpan: { start: 2_000, end: 2_000 },
				},
				{
					signal: "click",
					span: { start: 4_800, end: 7_800 },
					focus: { cx: 0.75, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
					intentSpan: { start: 4_000, end: 4_000 },
				},
			],
			durationMs: 60_000,
		});

		// The 800 ms visible gap is short enough for the normal connected-pan
		// renderer. It must not fall into the old gap between chain and spacing
		// rules and disappear.
		expect(selected).toHaveLength(2);
	});

	it("keeps a separate intent just beyond the connected-pan window", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 1_000, end: 4_000 },
					focus: { cx: 0.25, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 10,
				},
				{
					signal: "click",
					span: { start: 5_699, end: 8_699 },
					focus: { cx: 0.75, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 60_000,
		});

		// The 1,699 ms gap from the live recording is too long to connect, but
		// it must remain a valid separate effect instead of falling into a dead zone.
		expect(selected).toHaveLength(2);
	});

	it("reserves camera direction before ranking screen candidates", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 2_000, end: 5_000 },
					focus: { cx: 0.25, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 100,
				},
				{
					signal: "click",
					span: { start: 12_000, end: 15_000 },
					focus: { cx: 0.75, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 60_000,
			occupiedDirections: [{ start: 1_000, end: 6_000 }],
			maximumTotalDirectionsPerMinute: 5,
		});

		expect(selected).toHaveLength(1);
		expect(selected[0].span).toEqual({ start: 12_000, end: 15_000 });
	});

	it("enforces separate screen and combined direction budgets", () => {
		const candidates = [10_000, 20_000, 30_000, 40_000].map((start, index) => ({
			signal: "click" as const,
			span: { start, end: start + 3_000 },
			focus: { cx: 0.2 + index * 0.2, cy: 0.5 },
			focusMode: "manual" as const,
			customScale: 1.5,
			score: 10 - index,
		}));
		const selected = selectDirectionCandidates({
			candidates,
			durationMs: 60_000,
			occupiedDirections: [
				{ start: 1_000, end: 4_000 },
				{ start: 50_000, end: 53_000 },
			],
			maximumTotalDirectionsPerMinute: 5,
		});

		expect(selected).toHaveLength(3);
	});

	it("enforces the minimum duration after every detector adjustment", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 1_000, end: 3_000 },
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 10_000,
		});

		expect(selected).toEqual([]);
	});

	it("uses a rolling minute budget instead of a whole-project average", () => {
		const candidates = [5_000, 15_000, 25_000, 35_000, 45_000, 75_000].map((start, index) => ({
			signal: "click" as const,
			span: { start, end: start + 3_000 },
			focus: { cx: 0.2 + (index % 3) * 0.25, cy: 0.5 },
			focusMode: "manual" as const,
			customScale: 1.5,
			score: 20 - index,
		}));

		const selected = selectDirectionCandidates({
			candidates,
			durationMs: 120_000,
			policy: { ...DEFAULT_DIRECTION_POLICY, maxZoomsPerMinute: 4 },
		});

		expect(selected.map((candidate) => candidate.span.start)).toEqual([
			5_000, 15_000, 25_000, 35_000, 75_000,
		]);
	});

	it("counts internal pans as one rolling editorial entrance", () => {
		const connected = [
			{
				signal: "click" as const,
				span: { start: 1_000, end: 2_200 },
				focus: { cx: 0.2, cy: 0.5 },
				focusMode: "manual" as const,
				customScale: 1.5,
				score: 5,
				sequenceId: "one-passage",
				sequenceSpan: { start: 1_000, end: 5_000 },
			},
			{
				signal: "click" as const,
				span: { start: 3_000, end: 5_000 },
				focus: { cx: 0.8, cy: 0.5 },
				focusMode: "manual" as const,
				customScale: 1.5,
				score: 5,
				sequenceId: "one-passage",
				sequenceSpan: { start: 1_000, end: 5_000 },
			},
		];
		const selected = selectDirectionCandidates({
			candidates: [
				...connected,
				{
					signal: "click",
					span: { start: 20_000, end: 23_000 },
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 1,
				},
			],
			durationMs: 60_000,
			policy: { ...DEFAULT_DIRECTION_POLICY, maxZoomsPerMinute: 1 },
		});

		expect(selected).toEqual(connected);
	});

	it("counts nearby independent passages as separate entrances", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 1_000, end: 4_000 },
					focus: { cx: 0.2, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 10,
				},
				{
					signal: "click",
					span: { start: 4_800, end: 7_800 },
					focus: { cx: 0.8, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 60_000,
			policy: { ...DEFAULT_DIRECTION_POLICY, maxZoomsPerMinute: 1 },
		});

		expect(selected).toHaveLength(1);
		expect(selected[0].span).toEqual({ start: 1_000, end: 4_000 });
	});

	it("keeps the final selection deterministic under a dense technical passage", () => {
		const candidates = Array.from({ length: 24 }, (_, index) => ({
			signal: "click" as const,
			span: { start: index * 5_000, end: index * 5_000 + 3_000 },
			focus: { cx: 0.2 + (index % 4) * 0.2, cy: 0.5 },
			focusMode: "manual" as const,
			customScale: 1.5,
			score: 100 - index,
		}));
		const options = {
			candidates,
			durationMs: 120_000,
			policy: { ...DEFAULT_DIRECTION_POLICY, maxZoomsPerMinute: 6 },
		};

		const first = selectDirectionCandidates(options);
		const second = selectDirectionCandidates(options);
		expect(second).toEqual(first);
		for (const start of first.map((candidate) => candidate.span.start)) {
			expect(
				first.filter(
					(candidate) => candidate.span.start >= start && candidate.span.start < start + 60_000,
				).length,
			).toBeLessThanOrEqual(6);
		}
	});

	it("treats a context change as a hard direction boundary", () => {
		const plan = buildDirectionPlan({
			cursor: [
				point(0, 0.2, 0.5),
				{ ...point(1_000, 0.8, 0.5, "click"), directionContextChanged: true },
				point(3_500, 0.8, 0.5),
			],
			durationMs: 4_000,
		});

		expect(plan.zooms).toEqual([]);
	});

	it("counts adjacent screen and camera effects as separate total-budget directions", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 4_500, end: 7_500 },
					focus: { cx: 0.25, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 10,
				},
				{
					signal: "click",
					span: { start: 40_000, end: 43_000 },
					focus: { cx: 0.75, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 60_000,
			occupiedDirections: [
				{ start: 1_000, end: 4_000 },
				{ start: 10_000, end: 13_000 },
				{ start: 20_000, end: 23_000 },
				{ start: 30_000, end: 33_000 },
			],
			maximumTotalDirectionsPerMinute: 5,
		});

		// The screen effect at 4.5s sits near the first camera effect, but they
		// are different motions. They consume two total-budget slots rather than
		// becoming one connected sequence.
		expect(selected.map((candidate) => candidate.span)).toEqual([{ start: 4_500, end: 7_500 }]);
	});

	it("counts separated camera regions as separate total-budget directions", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 40_000, end: 43_000 },
					focus: { cx: 0.75, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 60_000,
			occupiedDirections: [
				{ start: 1_000, end: 4_000 },
				{ start: 5_000, end: 8_000 },
				{ start: 15_000, end: 18_000 },
				{ start: 25_000, end: 28_000 },
				{ start: 35_000, end: 38_000 },
			],
			maximumTotalDirectionsPerMinute: 5,
		});

		expect(selected).toEqual([]);
	});

	it("keeps touching camera groups separate in the total rolling budget", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 40_000, end: 43_000 },
					focus: { cx: 0.75, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 60_000,
			occupiedDirections: [
				{ start: 1_000, end: 4_000, directionGroupId: "camera-a" },
				{ start: 4_000, end: 8_000, directionGroupId: "camera-b" },
				{ start: 15_000, end: 18_000, directionGroupId: "camera-c" },
				{ start: 25_000, end: 28_000, directionGroupId: "camera-d" },
				{ start: 35_000, end: 38_000, directionGroupId: "camera-e" },
			],
			maximumTotalDirectionsPerMinute: 5,
		});

		expect(selected).toEqual([]);
	});

	it("keeps the same direction group separate across a removed segment", () => {
		const selected = selectDirectionCandidates({
			candidates: [
				{
					signal: "click",
					span: { start: 20_000, end: 23_000 },
					focus: { cx: 0.75, cy: 0.5 },
					focusMode: "manual",
					customScale: 1.5,
					score: 5,
				},
			],
			durationMs: 60_000,
			occupiedZooms: [
				{
					start: 1_000,
					end: 4_000,
					directionGroupId: "screen-a",
					segmentId: "clip-a:0",
				},
				{
					start: 4_000,
					end: 8_000,
					directionGroupId: "screen-a",
					segmentId: "clip-a:1",
				},
			],
			policy: { ...DEFAULT_DIRECTION_POLICY, maxZoomsPerMinute: 2 },
		});

		expect(selected).toEqual([]);
	});

	it("treats press, drag path, and release as one scored direction gesture", () => {
		const plan = buildDirectionPlan({
			cursor: [
				point(900, 0.8, 0.7),
				point(1_000, 0.8, 0.7, "click"),
				point(1_500, 0.65, 0.6),
				point(2_100, 0.45, 0.5),
				point(2_700, 0.25, 0.4),
				point(3_000, 0.2, 0.35, "mouseup"),
			],
			durationMs: 6_000,
		});

		expect(plan.zooms).toHaveLength(1);
		expect(new Set(plan.zooms.map((zoom) => zoom.sequenceId)).size).toBe(1);
		const final = plan.zooms.at(-1)!;
		const halfViewport = 0.5 / final.customScale;
		expect(final.focus.cx + halfViewport).toBeGreaterThanOrEqual(0.8);
		expect(final.focus.cy + halfViewport).toBeGreaterThanOrEqual(0.7);
		expect(final.focus.cx - halfViewport).toBeLessThanOrEqual(0.2);
		expect(final.focus.cy - halfViewport).toBeLessThanOrEqual(0.35);
		expect(plan.zooms.reduce((score, zoom) => score + zoom.score, 0)).toBe(5);
		expect(final.span.end).toBeGreaterThan(3_000);
	});

	it("pans across a wide drag when one useful stable crop cannot contain it", () => {
		const cursor = Array.from({ length: 7 }, (_, index) =>
			point(1_000 + index * 100, index / 6, 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(point(3_000, 1, 0.5));

		const plan = buildDirectionPlan({ cursor, durationMs: 4_000 });

		expect(plan.zooms.length).toBeGreaterThan(1);
		expect(plan.zooms.every((zoom) => zoom.focusMode === "manual")).toBe(true);
		expect(new Set(plan.zooms.map((zoom) => zoom.customScale))).toEqual(
			new Set([DEFAULT_CONNECTED_CLICK_POLICY.requestedScale]),
		);
		expect(plan.zooms[0].focus.cx).toBeLessThan(0.5);
		expect(plan.zooms.at(-1)!.focus.cx).toBeGreaterThan(0.5);
		expect(plan.zooms.reduce((score, zoom) => score + zoom.score, 0)).toBe(5);
	});

	it("keeps later clicks visible after a wide drag in the same passage", () => {
		const cursor = Array.from({ length: 7 }, (_, index) =>
			point(1_000 + index * 100, index / 6, 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(
			point(2_300, 0.2, 0.5, "click"),
			point(2_800, 0.2, 0.5, "click"),
			point(4_000, 0.2, 0.5),
		);

		const plan = buildDirectionPlan({ cursor, durationMs: 5_000 });

		expect(plan.zooms.length).toBeGreaterThan(2);
		expect(plan.zooms.at(-1)!.span.end).toBeGreaterThan(2_800);
		expect(plan.zooms.at(-1)!.focus.cx).toBeLessThan(0.5);
		expect(plan.zooms.reduce((score, zoom) => score + zoom.score, 0)).toBe(15);
	});

	it("keeps same-destination clicks after a wide drag without replacing its release", () => {
		const cursor = Array.from({ length: 7 }, (_, index) =>
			point(1_000 + index * 100, index / 6, 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(point(2_000, 1, 0.5, "click"), point(2_500, 1, 0.5, "click"), point(3_500, 1, 0.5));

		const plan = buildDirectionPlan({ cursor, durationMs: 4_500 });

		expect(plan.zooms.length).toBeGreaterThan(1);
		expect(plan.zooms.at(-1)!.span.end).toBeGreaterThan(2_500);
		expect(plan.zooms.reduce((score, zoom) => score + zoom.score, 0)).toBe(15);
	});

	it("keeps same-destination typing after a wide drag", () => {
		const cursor = Array.from({ length: 7 }, (_, index) =>
			point(1_000 + index * 100, index / 6, 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(point(3_500, 1, 0.5));
		const framingRect = { x: 0.76, y: 0.35, width: 0.22, height: 0.3 };
		const focusActivities = [2_000, 2_300, 2_600].map((timeMs, index) => ({
			timeMs,
			cx: 0.87,
			cy: 0.5,
			interactionType: "typing",
			directionActivityId: "typing-after-drag",
			directionWeight: index === 0 ? 1 : 0,
			framingRect,
		}));

		const plan = buildDirectionPlan({ cursor, focusActivities, durationMs: 4_500 });

		expect(plan.zooms.length).toBeGreaterThan(1);
		expect(plan.zooms.at(-1)!.span.end).toBeGreaterThan(2_600);
		expect(plan.zooms.reduce((score, zoom) => score + zoom.score, 0)).toBe(10);
	});

	it.each([
		180, 300,
	])("uses a destination Zoom after a %d ms drag that is faster than one smooth pan", (durationMs) => {
		const cursor = Array.from({ length: 7 }, (_, index) =>
			point(1_000 + (index * durationMs) / 6, index / 6, 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(point(3_000, 1, 0.5));

		const plan = buildDirectionPlan({ cursor, durationMs: 4_000 });

		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0].focus.cx).toBeGreaterThan(0.5);
		expect(plan.zooms[0].span.start).toBeGreaterThanOrEqual(1_000 + durationMs);
		expect(plan.zooms[0].score).toBe(5);
	});

	it("folds quick destination clicks into a short drag's post-release Zoom", () => {
		const cursor = Array.from({ length: 7 }, (_, index) =>
			point(1_000 + index * 30, index / 6, 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(point(1_300, 1, 0.5, "click"), point(1_600, 1, 0.5, "click"), point(3_000, 1, 0.5));

		const plan = buildDirectionPlan({ cursor, durationMs: 4_000 });

		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0].focus.cx).toBeGreaterThan(0.5);
		expect(plan.zooms[0].span.end).toBeGreaterThan(1_600);
		expect(plan.zooms[0].score).toBe(15);
	});

	it("folds quick destination typing into a short drag's post-release Zoom", () => {
		const cursor = Array.from({ length: 7 }, (_, index) =>
			point(1_000 + index * 30, index / 6, 0.5),
		);
		cursor[0].interactionType = "click";
		cursor.at(-1)!.interactionType = "mouseup";
		cursor.push(point(3_000, 1, 0.5));
		const framingRect = { x: 0.76, y: 0.35, width: 0.22, height: 0.3 };
		const focusActivities = [1_300, 1_450, 1_600].map((timeMs, index) => ({
			timeMs,
			cx: 0.87,
			cy: 0.5,
			interactionType: "typing",
			directionActivityId: "typing-after-short-drag",
			directionWeight: index === 0 ? 1 : 0,
			framingRect,
		}));

		const plan = buildDirectionPlan({ cursor, focusActivities, durationMs: 4_000 });

		expect(plan.zooms).toHaveLength(1);
		expect(plan.zooms[0].focus.cx).toBeGreaterThan(0.5);
		expect(plan.zooms[0].span.end).toBeGreaterThan(1_600);
		expect(plan.zooms[0].score).toBe(10);
	});

	it("retains hidden samples so detectors cannot bridge private intervals", () => {
		const normalized = normalizeDirectionCursor(
			[
				{ ...point(1_000, 0.2, 0.5), visible: true },
				{ ...point(1_500, 0.9, 0.5), visible: false },
				{ ...point(2_000, 0.2, 0.5), visible: true },
			],
			3_000,
		);

		expect(normalized).toHaveLength(3);
		expect(normalized[1].visible).toBe(false);
	});
});

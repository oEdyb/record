import { expect, test } from "vitest";
import {
	buildLabComparison,
	collapseClickSamples,
	findClickChains,
	interpolateCursor,
	normalizeCursorPayload,
	selectDefaultChain,
} from "./policy.mjs";

const sample = (timeMs, cx, cy, interactionType = "move", extra = {}) => ({
	timeMs,
	cx,
	cy,
	interactionType,
	visible: true,
	...extra,
});

test("normalizes, clamps, sorts, and removes malformed cursor samples", () => {
	const result = normalizeCursorPayload({
		samples: [sample(20, 2, -1), sample(10, 0.2, 0.3), sample(15, Number.NaN, 0.5)],
	});
	expect(result.map(({ timeMs, cx, cy }) => ({ timeMs, cx, cy }))).toEqual([
		{ timeMs: 10, cx: 0.2, cy: 0.3 },
		{ timeMs: 20, cx: 1, cy: 0 },
	]);
});

test("collapses native duplicate click-down samples but preserves separate targets", () => {
	const clicks = collapseClickSamples([
		sample(1_000, 0.2, 0.2, "click"),
		sample(1_040, 0.2, 0.2, "click"),
		sample(1_300, 0.8, 0.8, "click"),
	]);
	expect(clicks).toHaveLength(2);
});

test("groups the real right-left-right timing into one chain", () => {
	const samples = [
		sample(27_194, 0.48, 0.69, "click"),
		sample(28_671, 0.27, 0.35, "click"),
		sample(29_537, 0.72, 0.49, "click"),
		sample(31_003, 0.65, 0.68, "click"),
		sample(31_041, 0.65, 0.68, "click"),
		sample(31_937, 0.51, 0.57, "click"),
	];
	const chains = findClickChains(samples);
	expect(chains).toHaveLength(1);
	expect(chains[0].clicks).toHaveLength(5);
	expect(selectDefaultChain(chains)).toBe(chains[0]);
});

test("connected comparison reduces scale until the complete path stays visible", () => {
	const samples = [];
	const clicks = [sample(2_000, 0.2, 0.5, "click"), sample(3_200, 0.8, 0.5, "click")];
	for (let timeMs = 500; timeMs <= 5_500; timeMs += 50) {
		// The next target appears almost instantly. Anticipating the pan at the
		// requested depth would leave the old cursor position outside the crop.
		const progress = Math.max(0, Math.min(1, (timeMs - 3_150) / 50));
		samples.push(sample(timeMs, 0.2 + progress * 0.6, 0.5));
	}
	samples.push(...clicks);
	samples.sort((left, right) => left.timeMs - right.timeMs);
	const chain = findClickChains(samples)[0];
	const comparison = buildLabComparison(samples, chain, { requestedScale: 1.8 });
	const connected = comparison.variants.find((variant) => variant.id === "connected");
	expect(connected.resolvedScale).toBeLessThan(1.8);
	expect(connected.croppedFrames).toBe(0);
});

test("excluded private recorder clicks never enter a chain", () => {
	const chains = findClickChains([
		sample(1_000, 0.2, 0.2, "click", { directionExcluded: true }),
		sample(2_000, 0.5, 0.5, "click"),
	]);
	expect(chains).toHaveLength(1);
	expect(chains[0].clicks).toHaveLength(1);
});

test("preserves hidden cursor intervals instead of fabricating visible travel", () => {
	const samples = normalizeCursorPayload({
		samples: [
			sample(0, 0.2, 0.2),
			sample(100, 0.3, 0.3, "move", { visible: false }),
			sample(200, 0.8, 0.8, "move", { visible: false }),
			sample(300, 0.9, 0.9),
		],
	});
	expect(samples).toHaveLength(4);
	expect(interpolateCursor(samples, 150).visible).toBe(false);
});

test("keeps the cursor visible while the connected zoom exits", () => {
	const samples = [];
	for (let timeMs = 0; timeMs <= 6_000; timeMs += 50) {
		samples.push(sample(timeMs, timeMs < 4_200 ? 0.2 : 0.95, 0.5));
	}
	samples.push(sample(2_000, 0.2, 0.5, "click"), sample(3_200, 0.2, 0.5, "click"));
	samples.sort((left, right) => left.timeMs - right.timeMs);
	const chain = findClickChains(samples)[0];
	const connected = buildLabComparison(samples, chain).variants.find(
		(variant) => variant.id === "connected",
	);
	expect(connected.croppedFrames).toBe(0);
});

test("keeps the deepest visible zoom when edge padding is impossible", () => {
	const samples = [];
	for (let timeMs = 0; timeMs <= 5_000; timeMs += 50) {
		samples.push(sample(timeMs, 0.08, 0.08));
	}
	samples.push(sample(2_000, 0.08, 0.08, "click"));
	samples.sort((left, right) => left.timeMs - right.timeMs);
	const chain = findClickChains(samples)[0];
	const connected = buildLabComparison(samples, chain).variants.find(
		(variant) => variant.id === "connected",
	);
	expect(connected.resolvedScale).toBeCloseTo(1.65);
	expect(connected.croppedFrames).toBe(0);
	expect(connected.paddedBreaches).toBeGreaterThan(0);
});

test("serializes rapid distant pan transitions without overlap", () => {
	const samples = [
		sample(3_000, 0.2, 0.5, "click"),
		sample(3_600, 0.8, 0.5, "click"),
		sample(4_000, 0.2, 0.5, "click"),
	];
	const chain = findClickChains(samples)[0];
	const connected = buildLabComparison(samples, chain, {
		requestedScale: 1.2,
		safeInset: 0,
	}).variants.find((variant) => variant.id === "connected");
	for (let index = 1; index < connected.transitions.length; index += 1) {
		expect(connected.transitions[index].startMs).toBeGreaterThanOrEqual(
			connected.transitions[index - 1].endMs,
		);
	}
});

test("clamps the review window to the real media duration", () => {
	const samples = [sample(4_800, 0.5, 0.5, "click")];
	const chain = findClickChains(samples)[0];
	const comparison = buildLabComparison(samples, chain, { durationMs: 5_000 });
	expect(comparison.window.endMs).toBe(5_000);
});

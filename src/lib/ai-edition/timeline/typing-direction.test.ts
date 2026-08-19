import { describe, expect, it } from "vitest";
import type { KeyboardActivitySample } from "@/native/contracts";
import { buildTypingFocusAnchors, DEFAULT_TYPING_DIRECTION_POLICY } from "./typing-direction";

const key = (
	timeMs: number,
	cx = 0.5,
	cy = 0.5,
	extra: Partial<KeyboardActivitySample> = {},
): KeyboardActivitySample => ({
	timeMs,
	cx,
	cy,
	count: 1,
	focusSource: "caret",
	targetRect: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
	...extra,
});

describe("typing direction", () => {
	it("turns one sustained burst into click-style focus anchors with one score unit", () => {
		const anchors = buildTypingFocusAnchors({
			keyboardActivity: [key(1_000), key(1_200, 0.52), key(1_400, 0.55), key(1_600, 0.58)],
			durationMs: 3_000,
		});

		expect(anchors.length).toBeGreaterThanOrEqual(2);
		expect(anchors.every((anchor) => anchor.interactionType === "typing")).toBe(true);
		expect(anchors.reduce((total, anchor) => total + (anchor.directionWeight ?? 1), 0)).toBe(1);
		expect(anchors[0].framingRect).toMatchObject({ width: 0.46, height: 0.36 });
		expect(anchors[0].cx).toBeCloseTo(0.5);
	});

	it("ignores shortcuts and other brief keyboard activity", () => {
		expect(
			buildTypingFocusAnchors({
				keyboardActivity: [key(1_000, 0.5, 0.5, { count: 2 }), key(1_100)],
				durationMs: 3_000,
			}),
		).toEqual([]);
	});

	it("fails closed for private or excluded typing targets", () => {
		expect(
			buildTypingFocusAnchors({
				keyboardActivity: [
					key(1_000, 0.5, 0.5, { directionExcluded: true }),
					key(1_300, 0.5, 0.5, { directionExcluded: true, count: 3 }),
				],
				durationMs: 3_000,
			}),
		).toEqual([]);
	});

	it("ends the renewable activity at a private typing boundary", () => {
		const anchors = buildTypingFocusAnchors({
			keyboardActivity: [
				key(1_000),
				key(1_300),
				key(1_600),
				key(1_800, 0.5, 0.5, { directionExcluded: true }),
				key(2_000),
				key(2_300),
				key(2_600),
			],
			durationMs: 4_000,
		});

		expect(new Set(anchors.map((anchor) => anchor.directionActivityId)).size).toBe(2);
		expect(anchors.reduce((total, anchor) => total + (anchor.directionWeight ?? 1), 0)).toBe(2);
		expect(anchors.some((anchor) => anchor.timeMs === 1_800)).toBe(false);
	});

	it("keeps qualification values injectable through one typed policy", () => {
		const activity = [key(1_000), key(1_150), key(1_300)];
		expect(buildTypingFocusAnchors({ keyboardActivity: activity, durationMs: 3_000 })).not.toEqual(
			[],
		);
		expect(
			buildTypingFocusAnchors({
				keyboardActivity: activity,
				durationMs: 3_000,
				policy: { ...DEFAULT_TYPING_DIRECTION_POLICY, minimumKeyDownCount: 4 },
			}),
		).toEqual([]);
	});

	it("uses the latest same-target click when Accessibility returns only a broad target", () => {
		const targetRect = { x: 0.57, y: 0.08, width: 0.43, height: 0.84 };
		const anchors = buildTypingFocusAnchors({
			keyboardActivity: [
				key(6_198, 0.785, 0.5, { focusSource: "target", targetRect }),
				key(6_493, 0.785, 0.5, { focusSource: "target", targetRect }),
				key(6_777, 0.785, 0.5, { focusSource: "target", targetRect }),
			],
			cursorTelemetry: [
				{ timeMs: 5_254, cx: 0.777, cy: 0.876, visible: true, interactionType: "click" },
			],
			durationMs: 8_000,
		});

		expect(anchors).not.toEqual([]);
		expect(anchors.every((anchor) => anchor.cy > 0.75)).toBe(true);
		expect(anchors[0].framingRect?.y).toBeGreaterThan(0.58);
	});

	it("does not invent a typing location from the center of a broad target", () => {
		const targetRect = { x: 0.57, y: 0.08, width: 0.43, height: 0.84 };
		expect(
			buildTypingFocusAnchors({
				keyboardActivity: [
					key(1_000, 0.785, 0.5, { focusSource: "target", targetRect }),
					key(1_300, 0.785, 0.5, { focusSource: "target", targetRect }),
					key(1_600, 0.785, 0.5, { focusSource: "target", targetRect }),
				],
				cursorTelemetry: [
					{ timeMs: 900, cx: 0.2, cy: 0.8, visible: true, interactionType: "click" },
				],
				durationMs: 3_000,
			}),
		).toEqual([]);
	});

	it("can use a compact target center when no caret or click exists", () => {
		const targetRect = { x: 0.42, y: 0.43, width: 0.16, height: 0.08 };
		const anchors = buildTypingFocusAnchors({
			keyboardActivity: [
				key(1_000, 0.5, 0.47, { focusSource: "target", targetRect }),
				key(1_300, 0.5, 0.47, { focusSource: "target", targetRect }),
				key(1_600, 0.5, 0.47, { focusSource: "target", targetRect }),
			],
			durationMs: 3_000,
		});

		expect(anchors).not.toEqual([]);
		expect(anchors[0].cx).toBeCloseTo(0.5);
		expect(anchors[0].cy).toBeCloseTo(0.47);
	});

	it("does not carry a click into a different nearby typing target", () => {
		const firstTarget = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
		const secondTarget = { x: 0.4, y: 0.2, width: 0.28, height: 0.4 };
		const anchors = buildTypingFocusAnchors({
			keyboardActivity: [
				key(1_000, 0.25, 0.4, { focusSource: "target", targetRect: firstTarget }),
				key(1_150, 0.25, 0.4, { focusSource: "target", targetRect: firstTarget }),
				key(1_300, 0.25, 0.4, { focusSource: "target", targetRect: firstTarget }),
				key(1_400, 0.54, 0.4, { focusSource: "target", targetRect: secondTarget }),
				key(1_550, 0.54, 0.4, { focusSource: "target", targetRect: secondTarget }),
				key(1_700, 0.54, 0.4, { focusSource: "target", targetRect: secondTarget }),
			],
			cursorTelemetry: [
				{ timeMs: 900, cx: 0.25, cy: 0.4, visible: true, interactionType: "click" },
			],
			durationMs: 3_000,
		});

		expect(anchors).not.toEqual([]);
		expect(anchors.every((anchor) => anchor.timeMs < 1_400)).toBe(true);
	});

	it("keeps uninterrupted same-target typing renewable beyond six seconds", () => {
		const targetRect = { x: 0.57, y: 0.08, width: 0.43, height: 0.84 };
		const keyboardActivity = Array.from({ length: 27 }, (_, index) =>
			key(5_506 + index * 498, 0.785, 0.5, {
				focusSource: "target",
				targetRect,
			}),
		);
		const anchors = buildTypingFocusAnchors({
			keyboardActivity,
			cursorTelemetry: [
				{ timeMs: 4_225, cx: 0.779, cy: 0.872, visible: true, interactionType: "click" },
			],
			durationMs: 20_000,
		});

		expect(anchors[0].timeMs).toBe(5_506);
		expect(anchors.at(-1)!.timeMs).toBe(18_454);
		expect(anchors.reduce((total, anchor) => total + (anchor.directionWeight ?? 1), 0)).toBe(1);
	});

	it("starts a new activity after the typing idle gap", () => {
		const anchors = buildTypingFocusAnchors({
			keyboardActivity: [key(1_000), key(1_300), key(1_600), key(3_000), key(3_300), key(3_600)],
			durationMs: 5_000,
		});

		expect(new Set(anchors.map((anchor) => anchor.directionActivityId)).size).toBe(2);
		expect(anchors.reduce((total, anchor) => total + (anchor.directionWeight ?? 1), 0)).toBe(2);
	});
});

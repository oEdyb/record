// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeMacMouseButtonTransitions, resolveMacMouseInteraction } from "./macInputEvents";

describe("macOS input event normalization", () => {
	it("preserves a fast press and release from the same helper interval", () => {
		expect(
			normalizeMacMouseButtonTransitions([
				{ kind: "up", timestampMs: 1_003, x: 30, y: 40 },
				{ kind: "down", timestampMs: 1_000, x: 30, y: 40 },
			]),
		).toEqual([
			{ kind: "down", timestampMs: 1_000, x: 30, y: 40 },
			{ kind: "up", timestampMs: 1_003, x: 30, y: 40 },
		]);
	});

	it("drops malformed transition payloads", () => {
		expect(
			normalizeMacMouseButtonTransitions([
				{ kind: "right", timestampMs: 1_000, x: 0, y: 0 },
				{ kind: "down", timestampMs: Number.NaN, x: 0, y: 0 },
			]),
		).toEqual([]);
	});

	it("does not infer a duplicate release from an ordered batch state", () => {
		expect(
			resolveMacMouseInteraction({
				leftButtonDown: false,
				leftButtonPressed: false,
				leftButtonReleased: false,
				previousLeftButtonDown: true,
				inferStateTransition: false,
			}),
		).toBe("move");
		expect(
			resolveMacMouseInteraction({
				leftButtonDown: false,
				leftButtonPressed: false,
				leftButtonReleased: true,
				previousLeftButtonDown: false,
				inferStateTransition: false,
			}),
		).toBe("mouseup");
	});
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	normalizeMacMouseButtonTransitions,
	resolveMacKeyboardDirectionExcluded,
	resolveMacMouseInteraction,
} from "./macInputEvents";

describe("macOS input event normalization", () => {
	it("does not exclude typing in another app when a broad target centre overlaps the camera preview", () => {
		expect(
			resolveMacKeyboardDirectionExcluded({
				focusPointExcluded: true,
				focusSource: "target",
				hostProcessId: 100,
				targetProcessId: 200,
			}),
		).toBe(false);
	});

	it("excludes typing owned by Klippt without storing the target process", () => {
		expect(
			resolveMacKeyboardDirectionExcluded({
				focusPointExcluded: false,
				focusSource: "caret",
				hostProcessId: 100,
				targetProcessId: 100,
			}),
		).toBe(true);
	});

	it("uses only a precise caret for legacy geometry exclusion", () => {
		expect(
			resolveMacKeyboardDirectionExcluded({
				focusPointExcluded: true,
				focusSource: "caret",
				hostProcessId: 100,
			}),
		).toBe(true);
		expect(
			resolveMacKeyboardDirectionExcluded({
				focusPointExcluded: true,
				focusSource: "target",
				hostProcessId: 100,
			}),
		).toBe(false);
	});

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

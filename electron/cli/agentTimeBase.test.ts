// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	findUnbasedSecFields,
	parseTimeInput,
	resolveEditedSeconds,
	resolveTimelineInstant,
} from "./agentTimeBase";

describe("parseTimeInput", () => {
	it.each([
		["103", "edited", { seconds: 103, base: "edited" }],
		["103e", "edited", { seconds: 103, base: "edited" }],
		["1:43", "edited", { seconds: 103, base: "edited" }],
		["1:43", "source", { seconds: 103, base: "edited" }],
		["1:43.5", "edited", { seconds: 103.5, base: "edited" }],
		["125.324r", "edited", { seconds: 125.324, base: "raw" }],
		["10.418s", "edited", { seconds: 10.418, base: "source" }],
		["103", "source", { seconds: 103, base: "source" }],
		["103", "raw", { seconds: 103, base: "raw" }],
		["2:05r", "edited", { seconds: 125, base: "raw" }],
	] as const)("parses %s with default %s", (value, defaultBase, expected) => {
		expect(parseTimeInput(value, defaultBase)).toEqual(expected);
	});

	it.each([103, 0, 10.418])("parses bare number %s in the default base", (value) => {
		expect(parseTimeInput(value, "edited")).toEqual({ seconds: value, base: "edited" });
		expect(parseTimeInput(value, "raw")).toEqual({ seconds: value, base: "raw" });
	});

	it("passes through the parsed object form unchanged", () => {
		expect(parseTimeInput({ seconds: 103, base: "raw" })).toEqual({
			seconds: 103,
			base: "raw",
		});
	});

	it.each(["abc", "-3", "1:75", "103x", "1:2:3", ""])("rejects %s", (value) => {
		expect(() => parseTimeInput(value)).toThrow("INVALID_INPUT");
	});
	it("rejects negative and non-finite numbers", () => {
		expect(() => parseTimeInput(-1)).toThrow("INVALID_INPUT");
		expect(() => parseTimeInput(Number.NaN)).toThrow("INVALID_INPUT");
	});
});

/**
 * Synthetic reproduction of the Kimi swarm rough cut's clip 13 identity
 * (HANDOFF.md, 2026-09-18 Task A: "State at 1:43 maps to raw 125.323996 /
 * source 10.417996 seconds in clip_recording_1789653794581_2"). The real
 * project file is not in this checkout; this map reproduces the same three
 * numbers: 22.323996 s trimmed out of the preceding clip, then
 * clip_recording_1789653794581_2 laid down at raw 114.906 from source 0.
 */
function kimiClip13Fixture(): AxcutDocument {
	const document = createEmptyDocument({
		projectId: "project",
		title: "Kimi clip 13 synthetic",
		createdAt: "2026-09-18T00:00:00Z",
	});
	document.assets = [
		{
			id: "asset_a",
			kind: "video",
			label: "Before",
			originalPath: "/a.mp4",
			durationSec: 114.906,
			cameraTrack: null,
		},
		{
			id: "asset_b",
			kind: "video",
			label: "recording-…-clip-0013.mp4",
			originalPath: "/b.mp4",
			durationSec: 30.6,
			cameraTrack: null,
		},
	];
	document.timeline.clips = [
		{
			id: "clip_a",
			assetId: "asset_a",
			sourceStartSec: 0,
			sourceEndSec: 114.906,
			timelineStartSec: 0,
			timelineEndSec: 114.906,
			origin: "user",
			reason: "",
			wordRefs: [],
		},
		{
			id: "clip_recording_1789653794581_2",
			assetId: "asset_b",
			sourceStartSec: 0,
			sourceEndSec: 30.6,
			timelineStartSec: 114.906,
			timelineEndSec: 145.506,
			origin: "user",
			reason: "",
			wordRefs: [],
		},
	];
	document.timeline.trimRanges = [
		{
			id: "trim_a",
			clipId: "clip_a",
			assetId: "asset_a",
			startSec: 50,
			endSec: 72.323996,
			origin: "user",
			reason: "editorial",
		},
	];
	return document;
}

describe("resolveTimelineInstant on the Kimi clip 13 identity", () => {
	const document = kimiClip13Fixture();
	// 103 edited = 125.324 raw = 10.418 source (rounded to milliseconds).
	it.each([
		[{ seconds: 103, base: "edited" as const }, undefined],
		[{ seconds: 1 * 60 + 43, base: "edited" as const }, undefined],
		[{ seconds: 125.324, base: "raw" as const }, undefined],
		[{ seconds: 10.418, base: "source" as const }, "clip_recording_1789653794581_2"],
	])("resolves %j to the same instant", (input, clipId) => {
		const resolved = resolveTimelineInstant(document, input, { clipId });
		expect(resolved).toMatchObject({
			edited_sec: 103,
			raw_sec: 125.324,
			source_sec: 10.418,
			clip_id: "clip_recording_1789653794581_2",
			input_seconds: input.seconds,
			input_base: input.base,
		});
		expect(resolved.clip_index).toBe(2);
		expect(resolved.time_base.edited_sec).toContain("edited");
		expect(resolved.time_base.raw_sec).toContain("raw");
		expect(resolved.time_base.source_sec).toContain("source");
	});

	it("parses the CLI spellings of the identity to the same instant", () => {
		for (const spelling of ["103", "1:43", "103e"]) {
			expect(resolveTimelineInstant(document, parseTimeInput(spelling, "edited"))).toMatchObject({
				raw_sec: 125.324,
				source_sec: 10.418,
			});
		}
		expect(resolveTimelineInstant(document, parseTimeInput("125.324r", "edited"))).toMatchObject({
			edited_sec: 103,
		});
		expect(
			resolveTimelineInstant(document, parseTimeInput("10.418s", "edited"), {
				clipId: "clip_recording_1789653794581_2",
			}),
		).toMatchObject({ edited_sec: 103 });
	});

	it("resolves edited seconds for placement input without a clip", () => {
		expect(resolveEditedSeconds(document, { seconds: 125.324, base: "raw" })).toBe(103);
	});

	it("rejects instants outside the timeline", () => {
		expect(() => resolveTimelineInstant(document, { seconds: 999, base: "edited" })).toThrow(
			"TIME_OUTSIDE_PROJECT",
		);
		expect(() => resolveTimelineInstant(document, { seconds: 999, base: "source" })).toThrow(
			"TIME_OUTSIDE_PROJECT",
		);
		expect(() =>
			resolveTimelineInstant(document, { seconds: 200, base: "source" }, { clipId: "clip_a" }),
		).toThrow("TIME_OUTSIDE_PROJECT");
		expect(() => resolveTimelineInstant(document, { seconds: 3, base: "output" })).toThrow(
			"INVALID_INPUT",
		);
	});
});

describe("findUnbasedSecFields (check --rule reply.time-base)", () => {
	it("flags camelCase *Sec fields with no base label on the object or an ancestor", () => {
		expect(
			findUnbasedSecFields({ data: { currentTimeSec: 5, samples: [{ videoTimeSec: 3 }] } }),
		).toEqual(["$.data.currentTimeSec", "$.data.samples[0].videoTimeSec"]);
	});
	it("accepts a time_base/timeBase/time_bases label on the object or an ancestor", () => {
		expect(
			findUnbasedSecFields({
				time_bases: { currentTimeSec: "raw_virtual_seconds" },
				data: { currentTimeSec: 5 },
			}),
		).toEqual([]);
		expect(findUnbasedSecFields({ timeBase: "edited", state: { editedTimeSec: 1 } })).toEqual([]);
		expect(findUnbasedSecFields({ source: { time_base: "source_seconds", startSec: 1 } })).toEqual(
			[],
		);
	});
	it("exempts durations and offsets", () => {
		expect(
			findUnbasedSecFields({
				durationSec: 10,
				savedSec: 2,
				sourceOffsetSec: 1,
				remainingSec: 4,
				expiresAfterSeconds: 1800,
			}),
		).toEqual([]);
	});
	it("ignores snake_case fields and non-numbers", () => {
		expect(findUnbasedSecFields({ edited_sec: 103, at: "1:43" })).toEqual([]);
	});
});

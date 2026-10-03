import { describe, expect, it } from "vitest";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import {
	automaticDirectionGroupsForDocument,
	keepAutomaticDirectionGroup,
} from "../../src/lib/ai-edition/timeline/automatic-direction-ownership";
import { readAutomaticDirectionSettings } from "../../src/lib/ai-edition/timeline/automatic-direction-settings";
import { prepareAgentEditPlan } from "./agentEditPlan";

function document() {
	return documentSchema.parse({
		...createEmptyDocument({ projectId: "p", title: "Auto" }),
		assets: [
			{ id: "a", kind: "video", label: "Recording", originalPath: "/a.mp4", durationSec: 20 },
		],
		timeline: {
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
					origin: "user",
				},
			],
		},
		zoomRanges: [
			{
				id: "manual",
				startMs: 15000,
				endMs: 17000,
				depth: 1,
				focus: { cx: 0.4, cy: 0.4 },
				source: "manual",
			},
		],
		legacyEditor: {
			cameraFullscreenRegions: [
				{ id: "manual-camera", startMs: 18000, endMs: 19500, mode: "emphasis", source: "manual" },
			],
		},
	});
}
const observations = new Map([
	[
		0,
		[
			{
				assetId: "a",
				cursorTelemetry: [
					{ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" as const },
					{ timeMs: 4000, cx: 0.8, cy: 0.5, interactionType: "click" as const },
					{ timeMs: 8000, cx: 0.8, cy: 0.5, interactionType: "move" as const },
				],
			},
		],
	],
]);
describe("agent automatic direction operations", () => {
	it("runs, regenerates, and removes auto regions while preserving manual regions", () => {
		const base = document();
		const run = prepareAgentEditPlan(base, [{ type: "autoDirectionRun" }], observations);
		expect(run.candidate.zoomRanges.some((r) => r.source === "auto")).toBe(true);
		const regenerated = prepareAgentEditPlan(
			run.candidate,
			[{ type: "autoDirectionRegenerate" }],
			observations,
		);
		const removed = prepareAgentEditPlan(regenerated.candidate, [{ type: "autoDirectionRemove" }]);
		expect(removed.candidate.zoomRanges).toEqual(base.zoomRanges);
		expect(removed.candidate.legacyEditor?.cameraFullscreenRegions).toEqual(
			base.legacyEditor?.cameraFullscreenRegions,
		);
		expect(run.results[0]).toMatchObject({ result: { regions: { zoom: { removed: 0 } } } });
	});
	it("preserves generated groups promoted to manual ownership", () => {
		const run = prepareAgentEditPlan(
			document(),
			[{ type: "autoDirectionRun" }],
			observations,
		).candidate;
		const group = automaticDirectionGroupsForDocument(run)[0];
		const kept = keepAutomaticDirectionGroup(run, group.id);
		for (const type of ["autoDirectionRemove", "autoDirectionRegenerate"] as const) {
			const result = prepareAgentEditPlan(kept, [{ type }], observations).candidate;
			for (const region of kept.zoomRanges.filter((r) => r.source !== "auto"))
				expect(result.zoomRanges).toContainEqual(region);
		}
	});
	it("refuses regeneration without observations and persists validated policy changes", () => {
		expect(() => prepareAgentEditPlan(document(), [{ type: "autoDirectionRegenerate" }])).toThrow(
			"DIRECTION_OBSERVATIONS_UNAVAILABLE",
		);
		const plan = prepareAgentEditPlan(
			document(),
			[{ type: "autoDirectionRun", settings: { policy: { maximumScreenScale: 2.5 } } }],
			observations,
		);
		expect(readAutomaticDirectionSettings(plan.candidate).policy.maximumScreenScale).toBe(2.5);
		expect(() =>
			prepareAgentEditPlan(
				document(),
				[{ type: "autoDirectionRun", settings: { policy: { unknown: 1 } } }],
				observations,
			),
		).toThrow();
	});
});

it("refuses to erase a second asset's automatic regions when its observations are missing", () => {
	const base = document();
	base.timeline.clips.push({
		...base.timeline.clips[0],
		id: "other",
		assetId: "b",
		timelineStartSec: 20,
		timelineEndSec: 40,
	});
	base.zoomRanges.push({
		...base.zoomRanges[0],
		id: "auto-b",
		clipId: "other",
		sourceStartSec: 1,
		sourceEndSec: 3,
		startMs: 21000,
		endMs: 23000,
		source: "auto",
	});
	expect(() =>
		prepareAgentEditPlan(base, [{ type: "autoDirectionRegenerate" }], observations),
	).toThrow("DIRECTION_OBSERVATIONS_INCOMPLETE");
	expect(base.zoomRanges.some((r) => r.id === "auto-b")).toBe(true);
});

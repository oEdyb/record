import { describe, expect, it } from "vitest";
import { editFixture, word } from "../../src/lib/ai-edition/checks/fixtures";
import { resolveOverlaySpan } from "../../src/lib/ai-edition/timeline/overlayAnchors";
import { resolveVisibleClips } from "../../src/native/sceneDescription";
import { prepareAgentEditPlan } from "./agentEditPlan";
import { planChecks } from "./agentVerification";

function fixture() {
	let doc = editFixture({
		trims: [
			[1, 2],
			[8, 12],
			[18, 19],
		],
		words: [word("hello", 3, 4)],
	});
	doc.assets.push({
		id: "new",
		kind: "video",
		label: "New",
		originalPath: "/new.mp4",
		durationSec: 10,
		cameraTrack: null,
	});
	doc = prepareAgentEditPlan(doc, [
		{
			type: "addAnnotation",
			args: {
				text: "Words",
				startSec: 3,
				endSec: 4,
				anchor: {
					kind: "words",
					clipId: "clip",
					assetId: "asset",
					text: "hello",
					sourceStartSec: 3,
					sourceEndSec: 4,
				},
				position: { x: 0, y: 0 },
			},
		},
		{
			type: "addVideoOverlay",
			args: {
				assetId: "asset",
				startSec: 3,
				endSec: 6,
				anchor: { kind: "edited", fromSec: 2, toSec: 5 },
				sourceOffsetSec: 0,
			},
		},
		{ type: "addZoom", args: { startSec: 4, endSec: 5 } },
	]).candidate;
	return structuredClone(doc);
}
describe("replaceClipSource", () => {
	it("reports an edited overlay beyond the replacement end in range checks", () => {
		const before = prepareAgentEditPlan(fixture(), [
			{
				type: "addAnnotation",
				args: {
					text: "End",
					startSec: 12,
					endSec: 14,
					anchor: { kind: "edited", fromSec: 12, toSec: 14 },
					position: { x: 0, y: 0 },
				},
			},
		]).candidate;
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "replaceClipSource", args: { clipId: "clip", assetId: "new" } },
		]);
		expect(planChecks(candidate, { startSec: 0, endSec: 20 }).findings).toEqual(
			expect.arrayContaining([expect.objectContaining({ rule: "overlay.orphaned", at: 9 })]),
		);
		expect(candidate.annotations).toHaveLength(before.annotations.length);
	});
	it("uses the known replacement duration for an unprobed zero-length clip", () => {
		const before = fixture();
		before.timeline.clips[0].sourceEndSec = 0;
		before.timeline.clips[0].timelineEndSec = 0;
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "replaceClipSource", args: { clipId: "clip", assetId: "new" } },
		]);
		expect(candidate.timeline.clips[0]).toMatchObject({ sourceEndSec: 10, timelineEndSec: 10 });
	});
	it("keeps fitting trims and independent B-roll, drops incompatible trims with a report", () => {
		const before = fixture();
		const plan = prepareAgentEditPlan(before, [
			{ type: "replaceClipSource", args: { clipId: "clip", assetId: "new" } },
		]);
		expect(plan.operations).toHaveLength(1);
		expect(plan.candidate.timeline.trimRanges).toMatchObject([{ id: "trim_0", assetId: "new" }]);
		expect(plan.results[0].result).toMatchObject({
			keptTrims: ["trim_0"],
			droppedTrims: [{ id: "trim_1" }, { id: "trim_2" }],
		});
		expect(plan.candidate.videoOverlays).toEqual(before.videoOverlays);
		expect(plan.candidate.zoomRanges).toEqual(before.zoomRanges);
		expect(plan.candidate.timeline.clips[0]).toMatchObject({
			id: "clip",
			assetId: "new",
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		expect(
			planChecks(plan.candidate, { startSec: 0, endSec: 10 }).findings.some(
				(f) => f.rule === "overlay.orphaned",
			),
		).toBe(true);
		expect(before.timeline.clips[0].assetId).toBe("asset");
	});
	it("re-finds word anchors through the new transcript and updates asset provenance", () => {
		const before = fixture();
		before.transcripts.push({
			...before.transcripts[0],
			assetId: "new",
			words: [word("hello", 5, 6)],
		});
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "replaceClipSource", args: { clipId: "clip", assetId: "new" } },
		]);
		const anchor = candidate.annotations[0].anchor;
		expect(anchor).toMatchObject({ assetId: "new", sourceStartSec: 5, sourceEndSec: 6 });
		expect(anchor && resolveOverlaySpan(candidate, resolveVisibleClips(candidate), anchor)).toEqual(
			{ fromSec: 4, toSec: 5 },
		);
	});
	it("preserves shared legacy trims on sibling clips", () => {
		const before = fixture();
		before.timeline.clips.push({
			...before.timeline.clips[0],
			id: "sibling",
			timelineStartSec: 20,
			timelineEndSec: 40,
		});
		delete before.timeline.trimRanges[0].clipId;
		const { candidate } = prepareAgentEditPlan(before, [
			{ type: "replaceClipSource", args: { clipId: "clip", assetId: "new" } },
		]);
		expect(candidate.timeline.trimRanges.find((t) => t.id === "trim_0")).toEqual(
			before.timeline.trimRanges[0],
		);
		expect(
			candidate.timeline.trimRanges.some((t) => t.clipId === "clip" && t.assetId === "new"),
		).toBe(true);
		expect(candidate.timeline.clips[1]).toMatchObject({
			assetId: "asset",
			timelineStartSec: 10,
			timelineEndSec: 30,
		});
	});
});

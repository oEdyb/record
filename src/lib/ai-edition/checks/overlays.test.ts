import { describe, expect, it } from "vitest";
import { prepareAgentEditPlan } from "../../../../electron/ai-edition/agentEditPlan";
import { buildPlacement, placementIntentSchema } from "../../../../electron/cli/agentPlacement";
import { patchCaptionSettings } from "../captions/settings";
import { buildResolvedEdit } from "./context";
import { editFixture, word } from "./fixtures";
import { runChecks } from "./index";
import { regionBox } from "./overlayGeometry";

const text = (anchor = "top") =>
	placementIntentSchema.parse({
		kind: "text",
		action: "add",
		project_id: "project",
		from: 1,
		to: 5,
		text: "Text",
		anchor,
	});
function withText(anchor = "top") {
	const document = editFixture({ words: [word("spoken", 1, 2)] });
	return structuredClone(
		prepareAgentEditPlan(document, buildPlacement(document, text(anchor)).operations).candidate,
	);
}
describe("overlay rules", () => {
	it("reports text-camera intersection and not separated boxes", () => {
		const candidate = withText();
		const context = buildResolvedEdit(candidate);
		const region = context.regions.find((r) => r.kind === "annotation");
		expect(region).toBeDefined();
		const rect = regionBox(context, region!);
		expect(rect).not.toBeNull();
		const layout = context.scene.layout.layoutByClip?.[0];
		expect(layout).toBeDefined();
		layout!.webcamRect = { x: rect!.x, y: rect!.y, width: rect!.w, height: rect!.h };
		expect(runChecks(context, { rule: "text.over-camera" }).counts.error).toBe(1);
		layout!.webcamRect = { x: 0, y: 0.8, width: 0.1, height: 0.1 };
		expect(runChecks(context, { rule: "text.over-camera" }).total).toBe(0);
	});
	it("reports only B-roll drawn above overlapping text", () => {
		const document = withText();
		const candidate = structuredClone(
			prepareAgentEditPlan(document, [
				{ type: "addVideoOverlay", args: { assetId: "asset", startSec: 2, endSec: 3 } },
			]).candidate,
		);
		const context = buildResolvedEdit(candidate);
		expect(runChecks(context, { rule: "text.over-broll" }).total).toBe(0);
		const broll = context.regions.find((r) => r.kind === "video-overlay")!;
		broll.drawOrder = 1_000_000;
		expect(runChecks(context, { rule: "text.over-broll" }).findings[0]).toMatchObject({
			severity: "warning",
			span: { startSec: 2, endSec: 3 },
		});
		candidate.annotations[0].anchor = { kind: "edited", fromSec: 6, toSec: 8 };
		expect(runChecks(buildResolvedEdit(candidate), { rule: "text.over-broll" }).total).toBe(0);
	});
	it("respects caption draw order and reports disabled captions", () => {
		const document = patchCaptionSettings(editFixture({ words: [word("spoken", 1, 2)] }), {
			enabled: true,
		});
		const candidate = structuredClone(
			prepareAgentEditPlan(document, [
				{ type: "addVideoOverlay", args: { assetId: "asset", startSec: 0, endSec: 4 } },
			]).candidate,
		);
		const context = buildResolvedEdit(candidate);
		expect(runChecks(context, { rule: "broll.over-caption" }).total).toBe(0);
		const broll = context.regions.find((r) => r.kind === "video-overlay")!;
		broll.drawOrder = 1_000_000;
		expect(runChecks(context, { rule: "broll.over-caption" }).counts.warning).toBeGreaterThan(0);
		candidate.clipLayouts = { clip: { captions: false } };
		expect(
			runChecks(buildResolvedEdit(candidate), { rule: "broll.over-caption" }).findings[0].message,
		).toContain("captions are disabled");
		candidate.clipLayouts = {};
		const globallyOff = patchCaptionSettings(candidate, { enabled: false });
		expect(
			runChecks(buildResolvedEdit(globallyOff), { rule: "broll.over-caption" }).counts.warning,
		).toBe(1);
		const disabledContext = buildResolvedEdit(globallyOff);
		disabledContext.regions.find((r) => r.kind === "video-overlay")!.edited.startSec = -0.05;
		expect(runChecks(disabledContext, { rule: "broll.over-caption" }).findings[0].span).toEqual({
			startSec: 0,
			endSec: 4,
		});
		globallyOff.clipLayouts = { clip: { captions: true } };
		expect(runChecks(buildResolvedEdit(globallyOff), { rule: "broll.over-caption" }).total).toBe(0);
	});
	it("reports orphan words, past-end edited anchors, and removed legacy overlays with exact fixes", () => {
		const document = withText();
		document.annotations[0].anchor = {
			kind: "words",
			clipId: "clip",
			text: "missing",
			sourceStartSec: 1,
			sourceEndSec: 2,
		};
		let result = runChecks(buildResolvedEdit(document), { rule: "overlay.orphaned" });
		expect(result.findings[0].fix).toEqual([
			{ type: "removeAnnotation", args: { annotationId: document.annotations[0].id } },
		]);
		expect(
			prepareAgentEditPlan(document, result.findings[0].fix).candidate.annotations,
		).toHaveLength(0);
		document.annotations[0].anchor = { kind: "edited", fromSec: 19, toSec: 22 };
		expect(
			runChecks(buildResolvedEdit(document), { rule: "overlay.orphaned" }).counts.warning,
		).toBe(1);
		const candidate = structuredClone(
			prepareAgentEditPlan(editFixture(), [
				{ type: "addVideoOverlay", args: { assetId: "asset", startSec: 2, endSec: 4 } },
			]).candidate,
		);
		candidate.timeline.trimRanges = [
			{
				id: "cut",
				assetId: "asset",
				clipId: "clip",
				startSec: 1,
				endSec: 5,
				origin: "user",
				reason: "",
			},
		];
		result = runChecks(buildResolvedEdit(candidate), { rule: "overlay.orphaned" });
		expect(result.findings[0].fix).toEqual([
			{ type: "removeVideoOverlay", args: { videoOverlayId: candidate.videoOverlays![0].id } },
		]);
	});
});

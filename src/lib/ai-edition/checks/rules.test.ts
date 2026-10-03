import { describe, expect, it } from "vitest";
import {
	agentEditOperationSchema,
	prepareAgentEditPlan,
} from "../../../../electron/ai-edition/agentEditPlan";
import { buildResolvedEdit, type CheckEvidence } from "./context";
import { editFixture, word } from "./fixtures";
import { checkRules, runChecks } from "./index";

function check(
	rule: string,
	options: Parameters<typeof editFixture>[0] = {},
	evidence: CheckEvidence = {},
) {
	return runChecks(buildResolvedEdit(editFixture(options), evidence), { rule });
}

describe("edit check registry", () => {
	it("ships the fourteen exact rule ids", () => {
		expect(checkRules.map((rule) => rule.id)).toEqual([
			"camera.nested",
			"text.over-camera",
			"text.over-broll",
			"broll.over-caption",
			"overlay.orphaned",
			"camera.overlap",
			"region.near-cut",
			"region.off-cut",
			"caption.orphaned",
			"gap.silence",
			"cut.mid-sentence",
			"cut.loose-tail",
			"asset.missing",
			"layout.unused-override",
		]);
	});
	it("finds a nested emphasis and supplies a valid removal", () => {
		const result = check("camera.nested", {
			cameras: [
				{ id: "full", start: 1, end: 10 },
				{ id: "emphasis", start: 2, end: 4, mode: "emphasis" },
			],
		});
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({
			at: 2,
			clip: "clip",
			severity: "error",
			fix: [{ type: "removeModifier", args: { id: "emphasis" } }],
		});
		expect(agentEditOperationSchema.safeParse(result.findings[0].fix?.[0]).success).toBe(true);
	});
	it("does not report removed emphasis or partial containment as nested", () => {
		expect(
			check("camera.nested", {
				trims: [[2, 5]],
				cameras: [
					{ id: "full", start: 1, end: 10 },
					{ id: "emphasis", start: 2, end: 4, mode: "emphasis" },
				],
			}).total,
		).toBe(0);
		expect(
			check("camera.nested", {
				cameras: [
					{ id: "full", start: 1, end: 3 },
					{ id: "emphasis", start: 2, end: 4, mode: "emphasis" },
				],
			}).total,
		).toBe(0);
	});
	it("reports overlap only in kept footage and leaves touching pieces alone", () => {
		const cameras = [
			{ id: "a", start: 1, end: 6 },
			{ id: "b", start: 4, end: 8 },
		];
		expect(check("camera.overlap", { cameras }).findings[0].span).toEqual({
			startSec: 4,
			endSec: 6,
		});
		expect(check("camera.overlap", { cameras, trims: [[4, 6]] }).total).toBe(0);
	});
	it("reports authored edges near a cut once without invented split edges", () => {
		const result = check("region.near-cut", {
			trims: [[5, 10]],
			cameras: [
				{ id: "near", start: 10.4, end: 13 },
				{ id: "across", start: 1, end: 15 },
			],
		});
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].at).toBeCloseTo(5.4);
		expect(result.findings[0].message).toContain("snapped");
	});
	it("identifies a wholly removed region at its edited seam", () => {
		const result = check("region.off-cut", {
			trims: [[5, 10]],
			cameras: [
				{ id: "gone", start: 6, end: 9 },
				{ id: "kept", start: 9, end: 12 },
			],
		});
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({ at: 5, severity: "info", fix: null });
	});
	it("clips quiet spans to kept footage and skips missing microphone evidence", () => {
		const audio = new Map([
			[
				"asset",
				{
					microphonePeaks: new Float32Array([-0.1, 0.1]),
					quietSpans: [
						{ startSec: 1, endSec: 4 },
						{ startSec: 6, endSec: 10 },
					],
				},
			],
		]);
		const result = check("gap.silence", { trims: [[2, 8]] }, { audio });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].span).toEqual({ startSec: 2, endSec: 4 });
		expect(check("gap.silence").notes.join()).toContain("peaks unavailable");
	});
	it("uses the sentence planner for cut fixes and accepts its result", () => {
		const words = [
			word("First", 1, 2),
			word("sentence.", 2, 4),
			word("Second", 8, 9),
			word("sentence.", 9, 11),
		];
		const result = check("cut.mid-sentence", { trims: [[3, 8.5]], words });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].fix).toEqual([
			{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 4.15, endSec: 7.9 } },
		]);
		const fixed = prepareAgentEditPlan(
			editFixture({ trims: [[3, 8.5]], words }),
			result.findings.flatMap((item) => item.fix ?? []),
		);
		expect(runChecks(buildResolvedEdit(fixed.candidate), { rule: "cut.mid-sentence" }).total).toBe(
			0,
		);
		for (const item of result.findings)
			expect(agentEditOperationSchema.safeParse(item.fix?.[0]).success).toBe(true);
		expect(check("cut.mid-sentence", { trims: [[4.15, 7.9]], words }).total).toBe(0);
	});
	it("reports missing files and unknown file status separately", () => {
		expect(check("asset.missing", {}, { files: { "/take.mp4": false } }).counts.error).toBe(1);
		expect(check("asset.missing", {}, { files: { "/take.mp4": true } }).total).toBe(0);
		expect(check("asset.missing").notes.join()).toContain("file status unavailable");
	});
	it("reports missing camera sidecars separately from the screen source", () => {
		const result = check(
			"asset.missing",
			{},
			{ files: { "/take.mp4": true, "/camera.mp4": false } },
		);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].message).toContain("camera");
	});
	it("reports an overlay whose referenced asset is absent", () => {
		const document = editFixture();
		document.videoOverlays = [
			{
				id: "overlay",
				assetId: "absent",
				startMs: 1000,
				endMs: 3000,
				sourceOffsetSec: 0,
				fit: "cover",
				placement: null,
				opacity: 1,
			},
		];
		const result = runChecks(buildResolvedEdit(document), { rule: "asset.missing" });
		expect(result.findings[0]).toMatchObject({ at: 1, rule: "asset.missing" });
	});
	it("filters by edited range and rejects unknown rules", () => {
		const context = buildResolvedEdit(
			editFixture({
				cameras: [
					{ id: "full", start: 1, end: 10 },
					{ id: "e", start: 2, end: 4, mode: "emphasis" },
				],
			}),
		);
		expect(
			runChecks(context, { rule: "camera.nested", range: { startSec: 11, endSec: 12 } }).total,
		).toBe(0);
		expect(() => runChecks(context, { rule: "unknown" })).toThrow("Unknown check rule");
	});
	it("declares audio for every rule that reads microphone peaks", () => {
		expect(checkRules.filter((rule) => rule.audio).map((rule) => rule.id)).toEqual([
			"gap.silence",
			"cut.mid-sentence",
			"cut.loose-tail",
		]);
	});
});

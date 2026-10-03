import { describe, expect, it } from "vitest";
import { prepareAgentEditPlan } from "../../../../electron/ai-edition/agentEditPlan";
import { buildResolvedEdit } from "./context";
import { editFixture } from "./fixtures";
import { runChecks } from "./index";

describe("layout.unused-override", () => {
	it("reports a fully trimmed clip and supplies a clear operation", () => {
		const document = editFixture({ trims: [[0, 20]] });
		document.clipLayouts = { clip: { cameraSize: "L" } };
		const result = runChecks(buildResolvedEdit(document), { rule: "layout.unused-override" });
		expect(result.findings).toEqual([
			expect.objectContaining({
				rule: "layout.unused-override",
				severity: "info",
				at: 0,
				span: { startSec: 0, endSec: 0 },
				clip: "clip",
				fix: [{ type: "setClipLayout", clipId: "clip", layout: null }],
			}),
		]);
		const fixed = prepareAgentEditPlan(document, result.findings[0].fix ?? []).candidate;
		expect(runChecks(buildResolvedEdit(fixed), { rule: "layout.unused-override" }).total).toBe(0);
	});
	it("does not report a partially trimmed clip or a clip without an override", () => {
		const document = editFixture({ trims: [[1, 20]] });
		document.clipLayouts = { clip: { cameraSize: "L" } };
		expect(runChecks(buildResolvedEdit(document), { rule: "layout.unused-override" }).total).toBe(
			0,
		);
		expect(
			runChecks(buildResolvedEdit(editFixture({ trims: [[0, 20]] })), {
				rule: "layout.unused-override",
			}).total,
		).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { prepareAgentEditPlan } from "../../../../electron/ai-edition/agentEditPlan";
import { buildResolvedEdit } from "./context";
import { editFixture } from "./fixtures";
import { runChecks } from "./index";

function overlay(start: number, end: number) {
	const doc = prepareAgentEditPlan(editFixture({ trims: [[5, 10]] }), [
		{ type: "addVideoOverlay", args: { assetId: "asset", startSec: start, endSec: end } },
	]).candidate;
	return buildResolvedEdit(doc);
}
describe("subframe check fragments", () => {
	it("ignores the reviewer's 7.067–7.070s removed overlay sliver", () => {
		for (const rule of ["overlay.orphaned", "region.off-cut", "region.near-cut"])
			expect(runChecks(overlay(7.067, 7.07), { rule }).total).toBe(0);
	});
	it("keeps genuine removed overlays including exactly one frame", () => {
		for (const duration of [1 / 60, 0.5])
			for (const rule of ["overlay.orphaned", "region.off-cut"])
				expect(runChecks(overlay(7, 7 + duration), { rule }).total).toBe(1);
	});
	it("ignores a tiny projected piece of a long overlay near a cut", () => {
		expect(runChecks(overlay(4.997, 7), { rule: "region.near-cut" }).total).toBe(0);
		expect(runChecks(overlay(4.9, 7), { rule: "region.near-cut" }).total).toBe(1);
	});
});

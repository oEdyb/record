import { describe, expect, it } from "vitest";
import { buildResolvedEdit } from "./context";
import { editFixture, word } from "./fixtures";
import { runChecks } from "./index";

function captions() {
	const document = editFixture({
		trims: [[5, 10]],
		words: [word("Kept", 1, 2), word("Gone", 6, 7), word("Near", 10.1, 11)],
	});
	document.legacyEditor = {
		...document.legacyEditor,
		captions: { enabled: true, minWordsPerLine: 1, maxWordsPerLine: 1 },
	};
	return buildResolvedEdit(document);
}
describe("caption check exclusions", () => {
	it("ignores automatic captions near cuts and inside removed footage", () => {
		const context = captions();
		expect(context.authored.filter((region) => region.kind === "caption")).toHaveLength(3);
		expect(context.authored.some((region) => !region.pieces.length)).toBe(true);
		for (const rule of ["region.near-cut", "region.off-cut", "caption.orphaned"])
			expect(runChecks(context, { rule }).total).toBe(0);
	});
	it("reports only a removed caption with surviving words in its own clip", () => {
		const context = captions();
		const removed = context.authored.find((region) => !region.pieces.length);
		expect(removed?.captionSource).toBeDefined();
		if (!removed?.captionSource) throw new Error("Missing caption provenance");
		removed.captionSource.wordIds = ["word_1"];
		expect(runChecks(context, { rule: "caption.orphaned" }).findings).toMatchObject([
			{ severity: "info", at: 5, fix: null },
		]);
		removed.captionSource.clipIds = ["different-take"];
		expect(runChecks(context, { rule: "caption.orphaned" }).total).toBe(0);
		removed.captionSource = undefined;
		expect(runChecks(context, { rule: "caption.orphaned" }).total).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { buildResolvedEdit } from "./context";
import { cutLooseTail } from "./cut.loose-tail";
import { editFixture, word } from "./fixtures";
import { runChecks } from "./index";

const words = [
	word("First", 1, 2),
	word("sentence.", 2, 4),
	word("Second", 8, 9),
	word("sentence.", 9, 11),
];
function check(out: number, incoming: number, mic = true) {
	const document = editFixture({ words, trims: [[out, incoming]] });
	const microphonePeaks = new Float32Array(4000);
	for (let i = 0; i < 2000; i++) {
		const t = i / 100;
		const level = (t >= 1 && t < 4) || (t >= 8 && t < 11) ? 0.3 : 0.003;
		microphonePeaks[i * 2] = -level;
		microphonePeaks[i * 2 + 1] = level;
	}
	return runChecks(
		buildResolvedEdit(
			document,
			mic ? { audio: new Map([["asset", { microphonePeaks, quietSpans: [] }]]) } : {},
		),
		{ rule: cutLooseTail.id },
	);
}
describe("cut.loose-tail", () => {
	it("flags air kept after the last word before a cut, with a tightening fix", () => {
		const result = check(5, 7.9);
		expect(result.total).toBe(1);
		expect(result.findings[0].message).toMatch(/^Out-point 5.000s leaves 0.850s of air/);
		expect(result.findings[0].fix).toEqual([
			{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 4.15, endSec: 7.9 } },
		]);
	});
	it("flags air kept before the first word after a cut", () => {
		const result = check(4.15, 7);
		expect(result.total).toBe(1);
		expect(result.findings[0].message).toMatch(/^In-point 7.000s leaves 0.900s of air/);
	});
	it("accepts the planner's own padding and small air", () => {
		expect(check(4.15, 7.9).total).toBe(0);
		expect(check(4.45, 7.6).total).toBe(0);
	});
	it("stays silent without microphone peaks", () => {
		expect(check(5, 7, false).total).toBe(0);
		expect(check(5, 7, false).notes[0]).toContain("cut.loose-tail skipped");
	});
});

import { describe, expect, it } from "vitest";
import { buildResolvedEdit } from "./context";
import { cutMidSentence } from "./cut.mid-sentence";
import { editFixture, word } from "./fixtures";
import { runChecks, summarizeChecks } from "./index";

const words = [
	word("First", 1, 2),
	word("sentence.", 2, 4),
	word("Second", 8, 9),
	word("sentence.", 9, 11),
];
function check(out: number, mic = false, incoming = 7.9, extra?: (t: number) => number | null) {
	const document = editFixture({ words, trims: [[out, incoming]] });
	const microphonePeaks = new Float32Array(4000);
	for (let i = 0; i < 2000; i++) {
		const t = i / 100;
		const level = extra?.(t) ?? ((t >= 1 && t < 4) || (t >= 8 && t < 11) ? 0.3 : 0.003);
		microphonePeaks[i * 2] = -level;
		microphonePeaks[i * 2 + 1] = level;
	}
	return runChecks(
		buildResolvedEdit(
			document,
			mic ? { audio: new Map([["asset", { microphonePeaks, quietSpans: [] }]]) } : {},
		),
		{ rule: cutMidSentence.id },
	);
}
describe("cut evidence calibration", () => {
	it.each([3.85, 3.75, 3.651])("ignores transcript uncertainty at out %s", (out) => {
		expect(check(out).total).toBe(0);
	});
	it("includes exactly half a second of transcript disagreement", () => {
		expect(check(3.65).findings[0].cutEvidence).toMatchObject({
			method: "transcript",
			disagreementSec: expect.closeTo(0.5),
		});
	});
	it("keeps the microphone threshold at more than a quarter second", () => {
		expect(check(3.9, true).total).toBe(0);
		expect(check(3.89, true).findings[0].cutEvidence).toMatchObject({ method: "mic-level" });
	});
	it("ignores air kept after a sentence and before the next one", () => {
		expect(check(5).total).toBe(0);
		expect(check(5, true, 7.5).total).toBe(0);
	});
	it("ignores a late transcript word end when the microphone says the sentence ended", () => {
		expect(check(4.3, true).total).toBe(0);
		expect(check(4.3).total).toBe(0);
	});
	it("ignores a breath or room noise before an in-point but flags speech-level sound", () => {
		const breath = (t: number) => (t >= 7.3 && t < 8 ? 0.02 : null);
		expect(check(4.6, true, 7.9, breath).total).toBe(0);
		const voice = (t: number) => (t >= 7.3 && t < 8 ? 0.2 : null);
		const result = check(4.6, true, 7.9, voice);
		expect(result.total).toBe(1);
		expect(result.findings[0].message).toMatch(/^In-point/);
	});
	it("does not call a wordless blip removal inside a sentence mid-sentence", () => {
		const document = editFixture({
			words: [word("hello", 0.2, 2.5), word("again", 3.3, 5.6)].map((item) => ({
				...item,
				sourceRole: "you",
			})),
			trims: [[2.7, 3.1]],
		});
		const microphonePeaks = new Float32Array(4000);
		for (let i = 0; i < 2000; i++) {
			const t = i / 100;
			const level =
				(t >= 0.2 && t < 2.5) || (t >= 3.3 && t < 5.6) ? 0.3 : t >= 2.7 && t < 3.1 ? 0.2 : 0.003;
			microphonePeaks[i * 2] = -level;
			microphonePeaks[i * 2 + 1] = level;
		}
		const speechProbabilities = new Float32Array(625).fill(0.02);
		const evidence = {
			microphonePeaks,
			quietSpans: [],
			speechProbabilities,
			speechFrameSec: 0.032,
		};
		const audio = new Map([["asset", evidence]]);
		expect(
			runChecks(buildResolvedEdit(document, { audio }), { rule: cutMidSentence.id }).total,
		).toBe(0);
		for (const probabilities of [
			undefined,
			new Float32Array(625).fill(0.9),
			new Float32Array(50).fill(0.02),
		]) {
			const unverified = new Map([["asset", { ...evidence, speechProbabilities: probabilities }]]);
			expect(
				runChecks(buildResolvedEdit(document, { audio: unverified }), { rule: cutMidSentence.id })
					.total,
			).toBeGreaterThan(0);
		}
		const clipped = editFixture({
			words: [word("hello", 0.2, 2.5), word("uh", 2.8, 3.0), word("again", 3.3, 5.6)],
			trims: [[2.7, 3.1]],
		});
		expect(
			runChecks(buildResolvedEdit(clipped, { audio }), { rule: cutMidSentence.id }).total,
		).toBeGreaterThan(0);
	});
	it("never treats a stop closure inside a word as the end of speech", () => {
		const closure = (t: number) => (t >= 3.4 && t < 3.46 ? 0.003 : null);
		const result = check(3.9, true, 7.9, closure);
		expect(result.total).toBe(0);
		const clipped = check(3.5, true, 7.9, closure);
		expect(clipped.findings[0]?.message).toMatch(/should be 4\.1/);
	});
	it("compares a click against the real speech after a shortened pause, not the kept air", () => {
		const click = (t: number) => (t >= 7.2 && t < 7.26 ? 0.05 : null);
		expect(check(4.6, true, 7.4, click).total).toBe(0);
	});
	it("flags a tail the microphone hears after a sentence-end out-point", () => {
		const result = check(3.7, true);
		expect(result.total).toBe(1);
		expect(result.findings[0].message).toMatch(/^Out-point/);
	});
	it("flags an in-point that clips the first word of a sentence", () => {
		const result = check(4.6, false, 8.5);
		expect(result.total).toBe(1);
		expect(result.findings[0].message).toMatch(/^In-point/);
	});
	it("flags an out-point that ends inside the next sentence", () => {
		const result = check(8.5, false, 11.5);
		expect(result.total).toBe(1);
		expect(result.findings[0].message).toMatch(/^Out-point/);
	});
	it("reports one finding for both edges and preserves the corrected trim", () => {
		const result = check(3, false, 8.5);
		expect(result.total).toBe(1);
		expect(result.findings[0].fix).toEqual([
			{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 4.15, endSec: 7.9 } },
		]);
	});
	it("selects microphone evidence across asset results regardless of completion order", () => {
		const transcript = check(3).findings[0];
		const mic = {
			...check(3.89, true).findings[0],
			at: transcript.at,
			span: transcript.span,
			clip: "another-clip",
		};
		for (const findings of [
			[transcript, mic],
			[mic, transcript],
		]) {
			const result = summarizeChecks(
				findings.map((f) => ({ findings: [f] })),
				[cutMidSentence],
			);
			expect(result.findings).toEqual([mic]);
			expect(result.counts.error).toBe(1);
		}
	});
});

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutWord } from "../schema";
import { planCutPoint } from "./cut-point";

const clip: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 12,
	timelineStartSec: 0,
	timelineEndSec: 12,
	wordRefs: [],
	origin: "user",
	reason: "",
};

function word(text: string, startSec: number, endSec: number): AxcutWord {
	return { id: `w_${startSec}`, segmentId: "s", startSec, endSec, text, sourceRole: "you" };
}

// "That looks really cool." ends at 4.0 by the transcript, the voice really stops at 4.4,
// then "But we always have these hearts." starts at 8.0 by the transcript, the voice at 7.8.
const words = [
	word("That", 3.0, 3.2),
	word("looks", 3.2, 3.5),
	word("really", 3.5, 3.8),
	word("cool.", 3.8, 4.0),
	word("But", 8.0, 8.2),
	word("we", 8.2, 8.3),
	word("always", 8.3, 8.6),
	word("have", 8.6, 8.8),
	word("these", 8.8, 9.0),
	word("hearts.", 9.0, 9.4),
];

function peaks(loudRanges: Array<[number, number]>, durationSec = 12): Float32Array {
	const blocks = Math.ceil(durationSec / 0.01);
	const value = new Float32Array(blocks * 2);
	for (let index = 0; index < blocks; index += 1) {
		const time = index * 0.01;
		const loud = loudRanges.some(([start, end]) => time >= start && time < end);
		const amplitude = loud ? 0.3 : 0.003;
		value[index * 2] = -amplitude;
		value[index * 2 + 1] = amplitude;
	}
	return value;
}

const mic = peaks([
	[2.9, 4.4],
	[7.8, 9.5],
]);

describe("cut point", () => {
	it("ends the kept part where the last sound of the sentence stops, not where the transcript says", () => {
		const result = planCutPoint({
			clip,
			durationSec: 12,
			timeSec: 4.6,
			edge: "out",
			words,
			microphonePeaks: mic,
		});
		expect(result.chosen).toMatchObject({
			before: "That looks really cool.",
			after: "But we always have these hearts.",
			transcriptSec: 4.0,
			method: "mic-level",
		});
		expect(result.chosen?.audioSec).toBeCloseTo(4.4, 1);
		expect(result.chosen?.cutSec).toBeCloseTo(4.55, 1);
	});

	it("trusts the mic over a word end that speech-to-text smeared far into the silence", () => {
		const smeared = words.map((w) => (w.text === "cool." ? { ...w, endSec: 7.5 } : w));
		const result = planCutPoint({
			clip,
			durationSec: 12,
			timeSec: 4.6,
			edge: "out",
			words: smeared,
			microphonePeaks: mic,
		});
		expect(result.chosen?.transcriptSec).toBe(7.5);
		expect(result.chosen?.cutSec).toBeCloseTo(4.55, 1);
	});

	it("starts the kept part just before the first sound of the next sentence", () => {
		const result = planCutPoint({
			clip,
			durationSec: 12,
			timeSec: 8.3,
			edge: "in",
			words,
			microphonePeaks: mic,
		});
		expect(result.chosen).toMatchObject({ transcriptSec: 8.0, method: "mic-level" });
		expect(result.chosen?.audioSec).toBeCloseTo(7.8, 1);
		expect(result.chosen?.cutSec).toBeCloseTo(7.7, 1);
	});

	it("picks the sentence boundary nearest to the requested time and offers the others", () => {
		const result = planCutPoint({
			clip,
			durationSec: 12,
			timeSec: 9.2,
			edge: "out",
			words,
			microphonePeaks: mic,
		});
		expect(result.chosen?.before).toBe("But we always have these hearts.");
		expect(result.alternatives.map((c) => c.before)).toEqual(["That looks really cool."]);
	});

	it("treats a long gap without punctuation as a sentence end", () => {
		const unpunctuated = words.map((w) => ({ ...w, text: w.text.replace(".", "") }));
		const result = planCutPoint({
			clip,
			durationSec: 12,
			timeSec: 4.6,
			edge: "out",
			words: unpunctuated,
			microphonePeaks: mic,
		});
		expect(result.chosen?.before).toBe("That looks really cool");
	});

	it("falls back to the transcript timing without a microphone track", () => {
		const result = planCutPoint({
			clip,
			durationSec: 12,
			timeSec: 4.6,
			edge: "out",
			words,
		});
		expect(result.chosen).toMatchObject({ method: "transcript", audioSec: 4.0 });
		expect(result.chosen?.cutSec).toBeCloseTo(4.15, 2);
	});

	it("ignores system-audio words and returns nothing for a clip without words", () => {
		const system = words.map((w) => ({ ...w, sourceRole: "system" as const }));
		expect(
			planCutPoint({ clip, durationSec: 12, timeSec: 4, edge: "out", words: system }).chosen,
		).toBeNull();
	});
});

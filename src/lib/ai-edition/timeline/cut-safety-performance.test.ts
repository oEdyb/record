import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { AxcutClip, AxcutTranscript, AxcutWord } from "../schema";
import { analyzeClipPauses } from "./pause-analysis";

it.each([5, 30, 60])("plans a synthetic %i-minute transcript without crossing words", (minutes) => {
	const durationSec = minutes * 60;
	const clip: AxcutClip = {
		id: "long",
		assetId: "long",
		sourceStartSec: 0,
		sourceEndSec: durationSec,
		timelineStartSec: 0,
		timelineEndSec: durationSec,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
	const words: AxcutWord[] = [];
	for (let start = 0; start < durationSec; start += 3) {
		for (let i = 0; i < 4; i += 1) {
			words.push({
				id: `${start}_${i}`,
				segmentId: "s",
				text: "word",
				sourceRole: "you",
				startSec: start + i * 0.4,
				endSec: start + i * 0.4 + 0.3,
			});
		}
	}
	const transcript: AxcutTranscript = {
		assetId: "long",
		language: "en",
		words,
		segments: [],
		sources: [],
	};
	const microphonePeaks = Float32Array.from({ length: durationSec * 200 }, (_, index) =>
		(Math.floor(index / 2) / 100) % 3 < 1.5 ? 0.2 : 0.001,
	);
	const speechProbabilities = Float32Array.from(
		{ length: Math.ceil(durationSec / 0.032) },
		(_, index) => ((index * 0.032) % 3 < 1.8 ? 0.9 : 0.02),
	);
	const started = performance.now();
	const cuts = analyzeClipPauses({
		clip,
		durationSec,
		transcript,
		microphonePeaks,
		speechProbabilities,
		speechFrameSec: 0.032,
	});
	const elapsedMs = performance.now() - started;
	console.info(
		JSON.stringify({
			minutes,
			wordCount: words.length,
			frameCount: durationSec * 50,
			cutCount: cuts.length,
			elapsedMs,
		}),
	);
	expect(cuts).toHaveLength(durationSec / 3);
	for (const cut of cuts) {
		expect(cut.sourceStartSec % 3).toBeGreaterThanOrEqual(1.5);
		expect(Math.ceil(cut.sourceEndSec / 3)).toBe(Math.floor(cut.sourceStartSec / 3) + 1);
	}
});

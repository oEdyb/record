import { describe, expect, it } from "vitest";
import {
	buildMicrophoneActivitySpans,
	DEFAULT_MICROPHONE_ACTIVITY_POLICY,
} from "./microphone-activity";

function peaksFromFrames(amplitudes: number[], blocksPerFrame = 10): Float32Array {
	const peaks = new Float32Array(amplitudes.length * blocksPerFrame * 2);
	for (let frame = 0; frame < amplitudes.length; frame += 1) {
		for (let block = 0; block < blocksPerFrame; block += 1) {
			const index = (frame * blocksPerFrame + block) * 2;
			peaks[index] = -amplitudes[frame];
			peaks[index + 1] = amplitudes[frame];
		}
	}
	return peaks;
}

describe("buildMicrophoneActivitySpans", () => {
	it("returns no activity for silence or steady room noise", () => {
		expect(buildMicrophoneActivitySpans(peaksFromFrames(Array(200).fill(0)), 10_000)).toEqual([]);
		expect(buildMicrophoneActivitySpans(peaksFromFrames(Array(200).fill(0.02)), 10_000)).toEqual(
			[],
		);
	});

	it("bridges natural short gaps in varied microphone speech", () => {
		const amplitudes = Array.from({ length: 200 }, (_, index) => {
			if (index < 20 || index >= 180) return 0.001;
			if (index >= 80 && index < 86) return 0.001;
			return index % 4 === 0 ? 0.11 : index % 3 === 0 ? 0.065 : 0.035;
		});
		const spans = buildMicrophoneActivitySpans(peaksFromFrames(amplitudes), 10_000);
		expect(spans).toHaveLength(1);
		expect(spans[0].startMs).toBeGreaterThanOrEqual(900);
		expect(spans[0].endMs).toBeLessThanOrEqual(9_100);
		expect(spans[0].endMs - spans[0].startMs).toBeGreaterThan(7_000);
	});

	it("drops a single loud keyboard-like burst", () => {
		const amplitudes = Array(200).fill(0.001);
		amplitudes[100] = 0.4;
		expect(buildMicrophoneActivitySpans(peaksFromFrames(amplitudes), 10_000)).toEqual([]);
	});

	it("finds a useful speech burst even when most of a long clip is quiet", () => {
		const amplitudes = Array(1_200).fill(0.001);
		for (let index = 800; index < 960; index += 1) {
			amplitudes[index] = index % 4 === 0 ? 0.11 : index % 3 === 0 ? 0.065 : 0.035;
		}
		const spans = buildMicrophoneActivitySpans(peaksFromFrames(amplitudes), 60_000);
		expect(spans).toHaveLength(1);
		expect(spans[0].startMs).toBeGreaterThanOrEqual(39_900);
		expect(spans[0].endMs).toBeLessThanOrEqual(48_100);
		expect(spans[0].endMs - spans[0].startMs).toBeGreaterThan(7_500);
	});

	it("keeps microphone qualification thresholds tuneable through one policy", () => {
		const amplitudes = Array(200).fill(0.001);
		for (let index = 40; index < 120; index += 1) amplitudes[index] = 0.02;
		const peaks = peaksFromFrames(amplitudes);

		expect(buildMicrophoneActivitySpans(peaks, 10_000)).toEqual([]);
		expect(
			buildMicrophoneActivitySpans(peaks, 10_000, {
				...DEFAULT_MICROPHONE_ACTIVITY_POLICY,
				minimumVariationRatio: 1,
				variationOffset: 0,
			}),
		).toHaveLength(1);
	});
});

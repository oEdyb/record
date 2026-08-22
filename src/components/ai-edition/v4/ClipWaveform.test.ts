import { describe, expect, it } from "vitest";
import { buildWaveformColumns, computeReferenceWaveformGain } from "./ClipWaveform";

function expectColumns(actual: ReturnType<typeof buildWaveformColumns>, expected: typeof actual) {
	expect(actual).toHaveLength(expected.length);
	for (let index = 0; index < expected.length; index += 1) {
		expect(actual[index]?.min).toBeCloseTo(expected[index]?.min ?? 0);
		expect(actual[index]?.max).toBeCloseTo(expected[index]?.max ?? 0);
	}
}

describe("ClipWaveform", () => {
	it("preserves every source peak while fitting the waveform to visible columns", () => {
		const peaks = new Float32Array([-0.1, 0.2, -0.4, 0.3, 0, 0, -0.2, 0.1]);

		expectColumns(buildWaveformColumns(peaks, 4, 0, 4, 2), [
			{ min: -0.4, max: 0.3 },
			{ min: -0.2, max: 0.1 },
		]);
	});

	it("reveals more source detail when the rendered clip becomes wider", () => {
		const peaks = new Float32Array([-0.1, 0.1, -0.2, 0.2, -0.3, 0.3, -0.4, 0.4]);

		expect(buildWaveformColumns(peaks, 4, 0, 4, 2)).toHaveLength(2);
		expectColumns(buildWaveformColumns(peaks, 4, 0, 4, 4), [
			{ min: -0.1, max: 0.1 },
			{ min: -0.2, max: 0.2 },
			{ min: -0.3, max: 0.3 },
			{ min: -0.4, max: 0.4 },
		]);
	});

	it("draws only the selected source window", () => {
		const peaks = new Float32Array([-0.1, 0.1, -0.2, 0.2, -0.3, 0.3, -0.4, 0.4]);

		expectColumns(buildWaveformColumns(peaks, 4, 1, 3, 10), [
			{ min: -0.2, max: 0.2 },
			{ min: -0.3, max: 0.3 },
		]);
	});

	it("keeps real silence at zero and does not invent a minimum bar height", () => {
		const peaks = new Float32Array([0, 0, -0.001, 0.002]);

		expectColumns(buildWaveformColumns(peaks, 2, 0, 2, 2), [
			{ min: 0, max: 0 },
			{ min: -0.001, max: 0.002 },
		]);
		expect(computeReferenceWaveformGain(new Float32Array([0, 0, 0, 0]), 2, 0, 2)).toBe(1);
	});

	it("uses a robust reference gain so one transient does not flatten quiet detail", () => {
		const values: number[] = [];
		for (let index = 0; index < 100; index += 1) values.push(-0.05, 0.05);
		values.push(-1, 1);

		const gain = computeReferenceWaveformGain(new Float32Array(values), 101, 0, 101);
		expect(gain).toBeGreaterThan(8);
		expect(gain).toBeLessThanOrEqual(12);
	});

	it("scales a short signal independently of the digital silence around it", () => {
		const values = new Float32Array(2_202);
		for (let block = 1_000; block < 1_100; block += 1) {
			values[block * 2] = -0.05;
			values[block * 2 + 1] = 0.05;
		}
		values[2_200] = -1;
		values[2_201] = 1;

		const gain = computeReferenceWaveformGain(values, 1_101, 0, 1_101);
		expect(gain).toBeGreaterThan(8);
		expect(gain).toBeLessThanOrEqual(12);
	});
});

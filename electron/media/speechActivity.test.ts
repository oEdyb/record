import { describe, expect, it } from "vitest";
import { parseVadHelperReply } from "./speechActivity";

describe("Silero speech activity", () => {
	it("parses the native probability envelope and derives its frame clock", () => {
		const result = parseVadHelperReply(
			JSON.stringify({ sampleRate: 16_000, frameSamples: 512, probabilities: [0.1, 0.8, 1.4] }),
		);
		expect(result.frameSec).toBe(0.032);
		expect([...result.probabilities]).toEqual([expect.closeTo(0.1), expect.closeTo(0.8), 1]);
	});

	it("rejects malformed native output", () => {
		expect(() =>
			parseVadHelperReply(JSON.stringify({ sampleRate: 16_000, probabilities: [0.2] })),
		).toThrow(/invalid envelope/);
		expect(() =>
			parseVadHelperReply(
				JSON.stringify({ sampleRate: 16_000, frameSamples: 512, probabilities: ["speech"] }),
			),
		).toThrow(/non-numeric/);
	});
});

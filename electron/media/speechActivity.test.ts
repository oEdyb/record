import { describe, expect, it } from "vitest";
import {
	parseSpeechActivityCache,
	parseVadHelperReply,
	serializeSpeechActivityCache,
	shouldPersistSpeechActivityCache,
	sourceIdentityKey,
	speechEnvelopeCoversDuration,
} from "./speechActivity";

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

	it("round-trips raw and cleaned probability envelopes through the versioned cache", () => {
		const cached = serializeSpeechActivityCache({
			probabilities: new Float32Array([0.02, 0.4, 0.9]),
			cleanedProbabilities: new Float32Array([0.01, 0.7, 0.95]),
			frameSec: 0.032,
		});
		const result = parseSpeechActivityCache(cached);

		expect(result.frameSec).toBeCloseTo(0.032);
		expect([...(result.probabilities ?? [])]).toEqual([
			expect.closeTo(0.02),
			expect.closeTo(0.4),
			expect.closeTo(0.9),
		]);
		expect([...(result.cleanedProbabilities ?? [])]).toEqual([
			expect.closeTo(0.01),
			expect.closeTo(0.7),
			expect.closeTo(0.95),
		]);
	});

	it("rejects incomplete or corrupt probability caches", () => {
		expect(() => parseSpeechActivityCache(Buffer.from("old-cache"))).toThrow(/invalid header/);
		const cached = serializeSpeechActivityCache({
			probabilities: new Float32Array([0.1, 0.2]),
			frameSec: 0.032,
		});
		expect(() => parseSpeechActivityCache(cached.subarray(0, -1))).toThrow(/invalid shape/);
	});

	it("retries cleaned analysis instead of caching a raw-only fallback", () => {
		expect(
			shouldPersistSpeechActivityCache({
				probabilities: new Float32Array([0.1, 0.8]),
				frameSec: 0.032,
			}),
		).toBe(false);
		expect(
			shouldPersistSpeechActivityCache({
				probabilities: new Float32Array([0.1, 0.8]),
				cleanedProbabilities: new Float32Array([0.05, 0.9]),
				frameSec: 0.032,
			}),
		).toBe(true);
	});

	it("rejects an envelope that leaves more than one frame of decoded audio unknown", () => {
		expect(
			speechEnvelopeCoversDuration({ probabilities: new Float32Array(100), frameSec: 0.032 }, 3.22),
		).toBe(true);
		expect(
			speechEnvelopeCoversDuration({ probabilities: new Float32Array(100), frameSec: 0.032 }, 3.24),
		).toBe(false);
	});

	it("changes the cache identity when the same path is replaced without changing size or mtime", () => {
		const shared = {
			dev: 1n,
			size: 5_000n,
			mtimeNs: 10_000n,
		};
		const original = sourceIdentityKey("/recording.mp4", {
			...shared,
			ino: 20n,
			ctimeNs: 30_000n,
		});
		const replacement = sourceIdentityKey("/recording.mp4", {
			...shared,
			ino: 21n,
			ctimeNs: 31_000n,
		});
		expect(replacement).not.toBe(original);
	});
});

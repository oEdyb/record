import { describe, expect, it } from "vitest";

import { mergeTranscriptChunks, type TranscriptChunkResult } from "./seamMerge";

function chunk(
	index: number,
	coreStartSec: number,
	words: Array<{ word: string; startSec: number; endSec: number; confidence?: number }>,
): TranscriptChunkResult {
	return {
		index,
		decodeStartSec: Math.max(0, coreStartSec - 1.5),
		decodeEndSec: coreStartSec + 76.5,
		coreStartSec,
		coreEndSec: coreStartSec + 75,
		segments: [],
		wordSegments: words.map((word) => ({ ...word, sourceRole: "you" })),
	};
}

describe("mergeTranscriptChunks", () => {
	it("keeps one copy of words decoded on both sides of a seam", () => {
		const result = mergeTranscriptChunks([
			chunk(0, 0, [
				{ word: "before", startSec: 73.5, endSec: 74 },
				{ word: "boundary", startSec: 74.8, endSec: 75.2, confidence: 0.7 },
			]),
			chunk(1, 75, [
				{ word: "boundary", startSec: 74.9, endSec: 75.3, confidence: 0.9 },
				{ word: "after", startSec: 75.5, endSec: 76 },
			]),
		]);

		expect(result.wordSegments.map((word) => word.word)).toEqual(["before", "boundary", "after"]);
		expect(result.wordSegments[1]?.confidence).toBe(0.9);
	});

	it("rescues a seam word that only one window recognized", () => {
		const result = mergeTranscriptChunks([
			chunk(0, 0, [{ word: "before", startSec: 73.5, endSec: 74 }]),
			chunk(1, 75, [
				{ word: "rescued", startSec: 74.6, endSec: 74.95 },
				{ word: "after", startSec: 75.5, endSec: 76 },
			]),
		]);

		expect(result.wordSegments.map((word) => word.word)).toEqual(["before", "rescued", "after"]);
	});

	it("deduplicates the full right-context side of the overlap", () => {
		const result = mergeTranscriptChunks([
			chunk(0, 0, [{ word: "late", startSec: 76.3, endSec: 76.5 }]),
			chunk(1, 75, [{ word: "late", startSec: 76.35, endSec: 76.55 }]),
		]);

		expect(result.wordSegments.map((word) => word.word)).toEqual(["late"]);
	});

	it("does not collapse a real repeated word within one recognition window", () => {
		const result = mergeTranscriptChunks([
			chunk(0, 0, [
				{ word: "that", startSec: 10, endSec: 10.2 },
				{ word: "that", startSec: 10.3, endSec: 10.5 },
			]),
		]);

		expect(result.wordSegments.map((word) => word.word)).toEqual(["that", "that"]);
	});

	it("keeps repeated words on both sides of a seam while merging only the shared occurrence", () => {
		const result = mergeTranscriptChunks([
			chunk(0, 0, [
				{ word: "no", startSec: 73.9, endSec: 74.1 },
				{ word: "no", startSec: 74.9, endSec: 75.1 },
			]),
			chunk(1, 75, [
				{ word: "no", startSec: 74.95, endSec: 75.15 },
				{ word: "no", startSec: 75.9, endSec: 76.1 },
			]),
		]);

		expect(result.wordSegments.map((word) => word.word)).toEqual(["no", "no", "no"]);
	});
});

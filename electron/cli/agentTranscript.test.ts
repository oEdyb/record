// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { readAgentTranscript, readAllAgentTranscripts } from "./agentTranscript";

function fixture(withTranscript = true) {
	return documentSchema.parse({
		...createEmptyDocument({ title: "T", projectId: "p", createdAt: "2026-09-17T00:00:00.000Z" }),
		assets: [{ id: "a", kind: "video", label: "Screen", originalPath: "/s.mp4", durationSec: 20 }],
		timeline: {
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 2,
					sourceEndSec: 12,
					timelineStartSec: 0,
					timelineEndSec: 10,
					origin: "user",
				},
			],
		},
		transcripts: withTranscript
			? [
					{
						assetId: "a",
						language: "en",
						evidenceStatus: "verified",
						sources: [
							{
								sourceRole: "you",
								trackLanguageCode: "qac",
								sourceContentSha256: "a".repeat(64),
								backend: "parakeet-coreml",
								model: { id: "parakeet-v3", revision: "r", artifactSha256: ["b".repeat(64)] },
								language: { requested: "auto", detected: "en" },
								extraction: { version: 1, sampleRate: 16_000, channels: 1 },
								alignment: { version: 1, method: "recognizer-native-acoustic-snap" },
							},
						],
						words: [
							{
								id: "w0",
								segmentId: "s",
								startSec: 0.5,
								endSec: 1,
								text: "before",
								sourceRole: "you",
							},
							{
								id: "w1",
								segmentId: "s",
								startSec: 3,
								endSec: 3.4,
								text: "Hello",
								sourceRole: "you",
							},
							{
								id: "w2",
								segmentId: "s",
								startSec: 3.5,
								endSec: 4,
								text: "there",
								sourceRole: "you",
							},
							{
								id: "w3",
								segmentId: "s",
								startSec: 6,
								endSec: 6.5,
								text: "again",
								sourceRole: "you",
							},
							{
								id: "w4",
								segmentId: "s",
								startSec: 15,
								endSec: 16,
								text: "after",
								sourceRole: "you",
							},
						],
						segments: [
							{
								id: "s",
								kind: "speech",
								startSec: 3,
								endSec: 6.5,
								text: "Hello there again",
								sourceRole: "you",
							},
							{
								id: "s2",
								kind: "speech",
								startSec: 15,
								endSec: 16,
								text: "after",
								sourceRole: "you",
							},
						],
					},
				]
			: [],
	});
}

describe("agent transcript read", () => {
	it("returns source-time words, segments and gaps inside the clip window", () => {
		const result = readAgentTranscript(fixture(), { clipId: "c", minGapSec: 0.5 });
		if (!("words" in result)) throw new Error("expected a stored transcript");
		expect(result.words?.map((w) => w.text)).toEqual(["Hello", "there", "again"]);
		expect(result.segments?.map((s) => s.text)).toEqual(["Hello there again"]);
		expect(result.gaps).toEqual([
			{ start: 2, end: 3, duration: 1 },
			{ start: 4, end: 6, duration: 2 },
			{ start: 6.5, end: 12, duration: 5.5 },
		]);
		expect(result.next_offset).toBeNull();
	});

	it("pages words and reports the next offset", () => {
		const result = readAgentTranscript(fixture(), { clipId: "c", offset: 1, limit: 1 });
		if (!("words" in result)) throw new Error("expected a stored transcript");
		expect(result.words?.map((w) => w.text)).toEqual(["there"]);
		expect(result.next_offset).toBe(2);
	});

	it("reports a missing transcript without guessing and rejects unknown clips", () => {
		const result = readAgentTranscript(fixture(false), { clipId: "c" });
		expect(result.transcript.status).toBe("not_stored");
		expect("words" in result).toBe(false);
		expect(() => readAgentTranscript(fixture(), { clipId: "nope" })).toThrow(/UNKNOWN_CLIP/);
	});
});

describe("all transcript pages", () => {
	it("returns all clips, source words, sentences and missing-transcript commands", () => {
		const document = fixture();
		document.timeline.clips.push({
			...document.timeline.clips[0],
			id: "missing",
			assetId: "no-transcript",
		});
		const result = readAllAgentTranscripts(document);
		expect(result.clips.map((c) => c.id)).toEqual(["c", "missing"]);
		expect(result.clips[0].words.map((w) => w.text)).toEqual(["Hello", "there", "again"]);
		expect(result.clips[0].sentences.map((s) => s.text)).toEqual(["Hello there", "again"]);
		expect(result.missing).toEqual([
			{ id: "missing", name: "missing", name_truncated: false, status: "not_stored" },
		]);
		expect(result.next_actions[0].command).toBe("klippt agent transcribe --project_id p");
	});
	it("pages one large clip without losing words or sentences, below 48 KiB including envelope", () => {
		const document = fixture();
		document.timeline.clips[0].sourceEndSec = 10000;
		const original = document.transcripts[0].words[1];
		document.transcripts[0].words = Array.from({ length: 1500 }, (_, i) => ({
			...original,
			id: `w${i}`,
			startSec: 3 + i,
			endSec: 3.5 + i,
			text: `日本語${i}.`,
		}));
		const first = readAllAgentTranscripts(document);
		expect(first.pages).toBeGreaterThan(1);
		const words = [],
			sentences = [];
		for (let page = 1; page <= first.pages; page++) {
			const result = readAllAgentTranscripts(document, page);
			expect(
				Buffer.byteLength(
					JSON.stringify({
						api_version: "1.0",
						request_id: "x".repeat(36),
						status: "completed",
						snapshot: { sha256: "a".repeat(64) },
						data: result,
					}),
				),
			).toBeLessThan(48 * 1024);
			words.push(...result.clips.flatMap((c) => c.words));
			sentences.push(...result.clips.flatMap((c) => c.sentences));
			expect(result.next_page).toBe(page < first.pages ? page + 1 : null);
		}
		expect(words.map((w) => w.id)).toEqual(document.transcripts[0].words.map((w) => w.id));
		expect(sentences).toHaveLength(1500);
		expect(() => readAllAgentTranscripts(document, first.pages + 1)).toThrow("INVALID_PAGE");
	});
	it("splits very long sentence text into recoverable parts", () => {
		const document = fixture();
		document.transcripts[0].words[1].text = "文".repeat(25000);
		const first = readAllAgentTranscripts(document);
		const chunks = Array.from({ length: first.pages }, (_, i) =>
			readAllAgentTranscripts(document, i + 1),
		)
			.flatMap((p) => p.clips.flatMap((c) => c.words))
			.filter((w) => w.id === "w1");
		expect(chunks.map((c) => c.text).join("")).toBe("文".repeat(25000));
		expect(chunks[0]).toMatchObject({ part: 1, parts: 13 });
	});
});

it("retains segment-only transcript text and bounds long clip names", () => {
	const document = fixture();
	document.transcripts[0].words = [];
	document.assets[0].label = "x".repeat(50000);
	const page = readAllAgentTranscripts(document);
	expect(page.clips[0].sentences[0].text).toBe("Hello there again");
	expect(page.clips[0].name_truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(48 * 1024);
});

import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutTranscript,
	axcutSchemaVersion,
	documentSchema,
} from "../schema";
import { captionCorrectionWords, correctCaptionWords } from "./correction";
import { deriveCaptionCues } from "./cues";
import { getCaptionSettings, patchCaptionSettings } from "./settings";
import { getCaptionTranslations, putCaptionTranslation } from "./translations";

function transcript(): AxcutTranscript {
	return {
		assetId: "asset-1",
		language: "en",
		sources: [],
		segments: [
			{
				id: "seg_1",
				kind: "speech",
				startSec: 0,
				endSec: 2,
				text: "hello there friend",
				wordIds: ["w1", "w2", "w3"],
			},
			{
				id: "seg_2",
				kind: "speech",
				startSec: 4,
				endSec: 6,
				text: "goodbye now",
				wordIds: ["w4", "w5"],
			},
		],
		words: [
			{ id: "w1", segmentId: "seg_1", startSec: 0, endSec: 0.6, text: "hello" },
			{ id: "w2", segmentId: "seg_1", startSec: 0.6, endSec: 1.2, text: "there" },
			{ id: "w3", segmentId: "seg_1", startSec: 1.2, endSec: 2, text: "friend" },
			{ id: "w4", segmentId: "seg_2", startSec: 4, endSec: 5, text: "goodbye" },
			{ id: "w5", segmentId: "seg_2", startSec: 5, endSec: 6, text: "now" },
		],
	};
}

function doc(overrides: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "p1",
			title: "Test",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			primaryAssetId: "asset-1",
		},
		assets: [],
		transcript: null,
		transcripts: [transcript()],
		timeline: {
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		...overrides,
	} as AxcutDocument;
}

function fixture() {
	const document = doc();
	document.transcripts = document.transcripts.map((t) => ({
		...t,
		evidenceStatus: "legacy-unverified",
		words: t.words.map((w) => ({ ...w, sourceRole: "unknown-mixed" })),
		segments: t.segments.map((s) => ({ ...s, sourceRole: "unknown-mixed" })),
	}));
	return patchCaptionSettings(document, { enabled: true, minWordsPerLine: 3, maxWordsPerLine: 3 });
}
function cues(document: AxcutDocument) {
	return deriveCaptionCues(
		document,
		getCaptionSettings(document),
		getCaptionTranslations(document),
	);
}

describe("caption corrections", () => {
	it("updates source words and segment text without changing IDs, timing, clips or audio", () => {
		const original = fixture();
		const next = correctCaptionWords(original, cues(original)[0], { w2: "their" });
		expect(next.transcripts[0].words[1]).toEqual({
			...original.transcripts[0].words[1],
			text: "their",
		});
		expect(next.transcripts[0].segments[0].text).toBe("hello their friend");
		expect(next.timeline).toBe(original.timeline);
		expect(next.assets).toBe(original.assets);
		expect(original.transcripts[0].words[1].text).toBe("there");
		const loaded = documentSchema.parse(JSON.parse(JSON.stringify(next)));
		expect(cues(loaded)[0].text).toBe("hello their friend");
	});
	it("maps duplicate source clips to distinct cues but corrects their shared transcript", () => {
		const original = fixture();
		original.timeline.clips.push({
			...original.timeline.clips[0],
			id: "duplicate",
			timelineStartSec: 10,
			timelineEndSec: 20,
		});
		original.timeline.trimRanges.push({
			id: "cut",
			assetId: "asset-1",
			startSec: 0.1,
			endSec: 0.3,
			reason: "test",
			origin: "user",
		});
		const before = cues(original);
		expect(new Set(before.map((c) => c.id)).size).toBe(before.length);
		const selected = before.find((c) => c.startMs === 10000)!;
		expect(captionCorrectionWords(original, selected.id).map((w) => w.id)).toEqual([
			"w1",
			"w2",
			"w3",
		]);
		const next = correctCaptionWords(original, selected, { w1: "Hello" });
		expect(cues(next).filter((c) => c.text === "Hello there friend")).toHaveLength(2);
		expect(next.timeline).toBe(original.timeline);
	});
	it("rejects invalid, unknown and translated corrections without changing originals", () => {
		const original = fixture();
		const selected = cues(original)[0];
		const invalid: Record<string, string>[] = [
			{ w1: "" },
			{ w1: "two words" },
			{ w1: "x".repeat(101) },
			{ w5: "wrong-cue" },
			{ missing: "unknown" },
		];
		for (const replacements of invalid) {
			expect(() => correctCaptionWords(original, selected, replacements)).toThrow();
		}
		const translated = patchCaptionSettings(
			putCaptionTranslation(original, {
				language: "sv",
				label: "Swedish",
				assetId: "asset-1",
				segments: { seg_1: "hej" },
			}),
			{ language: "sv" },
		);
		expect(captionCorrectionWords(translated, selected.id)).toEqual([]);
		expect(() => correctCaptionWords(translated, selected, { w1: "changed" })).toThrow();
		const back = patchCaptionSettings(translated, { language: null });
		const next = correctCaptionWords(back, cues(back)[0], { w1: "Hello" });
		expect(getCaptionTranslations(next)).toEqual(getCaptionTranslations(back));
	});
	it("rejects a removed clip and preserves legacy primary transcript consistency", () => {
		const original = fixture();
		original.transcript = original.transcripts[0];
		const selected = cues(original)[0];
		const removed = { ...original, timeline: { ...original.timeline, clips: [] } };
		expect(() => correctCaptionWords(removed, selected, { w1: "Hello" })).toThrow();
		const next = correctCaptionWords(original, selected, { w1: "Hello" });
		expect(next.transcript).toBe(next.transcripts[0]);
	});
});

describe("caption source word provenance", () => {
	function withWords(entries: Array<{ text: string; startSec: number; endSec: number }>) {
		const original = patchCaptionSettings(fixture(), { minWordsPerLine: 1, maxWordsPerLine: 1 });
		const transcript = original.transcripts[0];
		transcript.words = entries.map((entry, index) => ({
			...entry,
			id: `w${index}`,
			segmentId: "seg",
			sourceRole: "unknown-mixed",
		}));
		transcript.segments = [
			{
				id: "seg",
				kind: "speech",
				startSec: 0,
				endSec: 5,
				text: entries.map((w) => w.text).join(" "),
				wordIds: transcript.words.map((w) => w.id),
				sourceRole: "unknown-mixed",
			},
		];
		return original;
	}
	it("keeps overlapping words attached only to the line that actually contains them", () => {
		const original = withWords([
			{ text: "alpha", startSec: 0, endSec: 2 },
			{ text: "beta", startSec: 1, endSec: 3 },
		]);
		const lines = cues(original);
		expect(lines.map((c) => [c.text, c.source?.wordIds])).toEqual([
			["alpha", ["w0"]],
			["beta", ["w1"]],
		]);
		expect(captionCorrectionWords(original, lines[1].id).map((w) => w.text)).toEqual(["beta"]);
		const next = correctCaptionWords(original, lines[1], { w1: "better" });
		expect(next.transcripts[0].words.map((w) => w.text)).toEqual(["alpha", "better"]);
		expect(() => correctCaptionWords(original, lines[1], { w0: "wrong" })).toThrow();
	});
	it("retains zero-duration words when display timing is expanded and clipped", () => {
		const original = withWords([
			{ text: "hello", startSec: 0, endSec: 0 },
			{ text: "world", startSec: 0, endSec: 1 },
		]);
		const lines = cues(original);
		expect(lines.map((c) => [c.text, c.source?.wordIds])).toEqual([
			["hello", ["w0"]],
			["world", ["w1"]],
		]);
		const next = correctCaptionWords(original, lines[0], { w0: "hi" });
		expect(next.transcripts[0].words.map((w) => w.text)).toEqual(["hi", "world"]);
		expect(next.transcripts[0].words[0].endSec).toBe(0);
	});
	it("preserves every source occurrence when repeat polishing collapses a line", () => {
		const original = withWords([
			{ text: "hello", startSec: 0, endSec: 1 },
			{ text: "hello", startSec: 1, endSec: 2 },
		]);
		const lines = cues(original);
		expect(lines).toHaveLength(1);
		expect(lines[0].source?.wordIds).toEqual(["w0", "w1"]);
		const next = correctCaptionWords(original, lines[0], { w0: "hi", w1: "hi" });
		expect(cues(next).map((c) => c.text)).toEqual(["hi"]);
	});
});

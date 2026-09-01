import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, type AxcutTranscript, axcutSchemaVersion } from "../schema";
import { toAxcutTranscriptDsl, transcribeAsset } from "./transcribe";

const transcribeSourceMock = vi.fn();
const cancelMock = vi.fn();

function sourceResult(language: string | null, text = "hello") {
	return {
		segments: [{ startSec: 0, endSec: 1, text, sourceRole: "you" as const }],
		wordSegments: [{ startSec: 0, endSec: 1, word: text, sourceRole: "you" as const }],
		detectedLanguage: language ?? "auto",
		backend: "parakeet-coreml" as const,
		sources: [
			{
				sourceRole: "you" as const,
				trackLanguageCode: "qac" as const,
				sourceContentSha256: "a".repeat(64),
				backend: "parakeet-coreml" as const,
				model: {
					id: "parakeet-v3" as const,
					revision: "revision",
					artifactSha256: ["b".repeat(64)],
				},
				language: { requested: "auto", detected: language ?? "auto" },
				extraction: { version: 1 as const, sampleRate: 16_000 as const, channels: 1 as const },
				alignment: {
					version: 1 as const,
					method: "recognizer-native-acoustic-snap" as const,
				},
			},
		],
	};
}

beforeEach(() => {
	transcribeSourceMock.mockReset();
	cancelMock.mockReset();
	vi.stubGlobal("window", {
		electronAPI: {
			stt: {
				transcribeSource: transcribeSourceMock,
				cancel: cancelMock,
			},
		},
	});
});

function makeDoc(): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-07-03T00:00:00Z",
			updatedAt: "2026-07-03T00:00:00Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "demo.mp4",
				originalPath: "/tmp/demo.mp4",
				durationSec: 60,
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

describe("toAxcutTranscriptDsl", () => {
	it("emits the AXCUT_TRANSCRIPT v1 header + META + segments + words", () => {
		const transcript: AxcutTranscript = {
			assetId: "asset_1",
			language: "en",
			sources: [],
			segments: [
				{
					id: "seg_1",
					kind: "speech",
					startSec: 0,
					endSec: 1.2,
					text: "okay so let's",
					wordIds: ["word_1", "word_2", "word_3"],
				},
			],
			words: [
				{ id: "word_1", segmentId: "seg_1", startSec: 0, endSec: 0.4, text: "okay" },
				{ id: "word_2", segmentId: "seg_1", startSec: 0.4, endSec: 0.7, text: "so" },
				{ id: "word_3", segmentId: "seg_1", startSec: 0.7, endSec: 1.2, text: "let's" },
			],
		};

		const dsl = toAxcutTranscriptDsl(transcript, "demo.mp4", 1.2);
		const lines = dsl.split("\n");

		expect(lines[0]).toBe("AXCUT_TRANSCRIPT v1");
		expect(lines[1]).toBe(
			'META source_video="demo.mp4" duration=1.200 language="en" kind="source"',
		);
		expect(lines).toContain(`SEGMENT id=s0001 start=0.000 end=1.200 text="okay so let''s"`);
		expect(lines).toContain('WORD id=w000001 segment=s0001 start=0.000 end=0.400 text="okay"');
		expect(lines).toContain('WORD id=w000002 segment=s0001 start=0.400 end=0.700 text="so"');
		expect(lines).toContain(`WORD id=w000003 segment=s0001 start=0.700 end=1.200 text="let''s"`);
		expect(lines.at(-1)).toBe("ENDSEGMENT");
	});

	it("escapes quotes in segment/word text (both kinds)", () => {
		const transcript: AxcutTranscript = {
			assetId: "asset_1",
			language: "auto",
			sources: [],
			segments: [
				{
					id: "seg_1",
					kind: "speech",
					startSec: 0,
					endSec: 1,
					text: 'he said "hi"',
					wordIds: ["word_1"],
				},
			],
			words: [{ id: "word_1", segmentId: "seg_1", startSec: 0, endSec: 1, text: "let's" }],
		};

		const dsl = toAxcutTranscriptDsl(transcript);
		expect(dsl).toContain(`text="he said ""hi"""`);
		expect(dsl).toContain(`text="let''s"`);
	});

	it("omits duration when not provided", () => {
		const transcript: AxcutTranscript = {
			assetId: "asset_1",
			language: "fr",
			sources: [],
			segments: [],
			words: [],
		};

		const dsl = toAxcutTranscriptDsl(transcript, "x.mp4");
		expect(dsl).toBe('AXCUT_TRANSCRIPT v1\nMETA source_video="x.mp4" language="fr" kind="source"');
	});
});

describe("transcribeAsset language handling", () => {
	it("does not start source transcription for an already-cancelled job", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			transcribeAsset(makeDoc(), "asset_1", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(transcribeSourceMock).not.toHaveBeenCalled();
	});

	it("drops a result that arrives after cancellation", async () => {
		let finish: ((value: ReturnType<typeof sourceResult>) => void) | undefined;
		transcribeSourceMock.mockImplementationOnce(
			async () =>
				await new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new AbortController();
		const run = transcribeAsset(makeDoc(), "asset_1", { signal: controller.signal });
		await vi.waitFor(() => expect(transcribeSourceMock).toHaveBeenCalledOnce());
		controller.abort();
		finish?.(sourceResult("en"));

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(cancelMock).toHaveBeenCalledOnce();
	});

	it("forwards a forced language to the worker and stores it on the transcript", async () => {
		transcribeSourceMock.mockResolvedValueOnce(sourceResult("fr", "bonjour"));

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1", { language: "fr" });

		// The forced ISO code reaches the underlying worker call.
		expect(transcribeSourceMock).toHaveBeenCalledWith(
			expect.objectContaining({ language: "fr", sourceKind: "import" }),
		);
		// The stored transcript reports the model-confirmed language.
		expect(t.language).toBe("fr");
	});

	it("omits the language option from the worker call when 'auto' so Whisper detects", async () => {
		transcribeSourceMock.mockResolvedValueOnce(sourceResult("en"));

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1", { language: "auto" });

		expect(transcribeSourceMock).toHaveBeenCalledWith(
			expect.objectContaining({ language: undefined }),
		);
		expect(t.language).toBe("en");
	});

	it("captures Whisper's auto-detected language when no option was passed", async () => {
		transcribeSourceMock.mockResolvedValueOnce(sourceResult("es", "hola"));

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1");

		expect(transcribeSourceMock).toHaveBeenCalledWith(
			expect.objectContaining({ language: undefined }),
		);
		expect(t.language).toBe("es");
	});

	it("keeps phrase-only system speech when microphone words have timing", async () => {
		transcribeSourceMock.mockResolvedValueOnce({
			...sourceResult("en"),
			segments: [
				{ text: "hello", startSec: 0, endSec: 0.5, sourceRole: "you" },
				{ text: "system reply", startSec: 1, endSec: 2, sourceRole: "system" },
			],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5, sourceRole: "you" }],
		});

		const transcript = await transcribeAsset(makeDoc(), "asset_1");
		expect(transcript.words.map((word) => [word.text, word.sourceRole])).toEqual([
			["hello", "you"],
			["system", "system"],
			["reply", "system"],
		]);
	});

	it("falls back to 'auto' when the model reports no language token", async () => {
		transcribeSourceMock.mockResolvedValueOnce({
			...sourceResult(null),
			segments: [],
			wordSegments: [],
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1");

		expect(t.language).toBe("auto");
	});
});

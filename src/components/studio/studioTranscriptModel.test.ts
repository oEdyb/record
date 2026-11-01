import { describe, expect, it } from "vitest";
import type { StudioSnapshot } from "../../../electron/studio/types";
import { buildStudioSections, studioTranscriptText } from "./studioTranscriptModel";

const word = (text: string, startSec: number, endSec = startSec + 0.3) => ({
	word: text,
	startSec,
	endSec,
	confidence: 1,
});

function snapshot(overrides: Partial<StudioSnapshot> = {}): StudioSnapshot {
	return {
		phase: "paused",
		setup: {
			source: null,
			micEnabled: false,
			micDeviceId: null,
			cameraEnabled: false,
			cameraDeviceId: null,
			systemAudioEnabled: false,
			cursorCaptureMode: "system",
			recordingQuality: "high",
		},
		pill: {
			controlsLocked: false,
			canRemovePreviousClip: false,
			undoClipIndex: null,
			countingDown: false,
			transportBusy: false,
			canPause: false,
			saving: false,
		},
		recordingId: 1,
		clips: [
			{ index: 0, screenVideoPath: "/r/0.mp4", durationMs: 10_000, microphoneAudioOffsetMs: 200 },
			{ index: 1, screenVideoPath: "/r/1.mp4", durationMs: 5_000, removed: true },
			{ index: 2, screenVideoPath: "/r/2.mp4", durationMs: 8_000 },
		],
		committedMs: 18_000,
		liveSinceMs: null,
		hiddenForCapture: false,
		holdPlayback: false,
		shown: true,
		transcript: {
			recordingId: 1,
			status: "idle",
			progress: null,
			download: null,
			error: null,
			updatedAt: 0,
			clips: [
				{
					index: 0,
					durationMs: 10_000,
					text: "Hello there. How are you?",
					words: [
						word("Hello", 1),
						word("there.", 1.5),
						word("How", 3),
						word("are", 3.3),
						word("you?", 3.6),
					],
					error: null,
				},
				{ index: 2, durationMs: 8_000, text: "Old cache text", words: null, error: null },
			],
		},
		...overrides,
	};
}

describe("buildStudioSections", () => {
	it("splits words into sentences that seek into the screen video", () => {
		const [first] = buildStudioSections(snapshot());
		expect(first.sentences.map((s) => s.text)).toEqual(["Hello there.", "How are you?"]);
		// Microphone time 3.0 s is screen time 3.2 s.
		expect(first.sentences[1]).toMatchObject({ clipSec: 3.2, takeSec: 3.2 });
	});

	it("skips removed clips and places later clips on the replay timeline", () => {
		const sections = buildStudioSections(snapshot());
		expect(sections.map((s) => s.clipIndex)).toEqual([0, 2]);
		expect(sections[1]).toMatchObject({ startSec: 10, state: "text" });
		expect(sections[1].sentences[0]).toMatchObject({ text: "Old cache text", takeSec: 10 });
	});

	it("adds the clip being recorded and marks clips still waiting", () => {
		const sections = buildStudioSections(
			snapshot({
				phase: "recording",
				transcript: { ...snapshot().transcript, status: "transcribing", clips: [] },
			}),
		);
		expect(sections.map((s) => [s.clipIndex, s.state])).toEqual([
			[0, "transcribing"],
			[2, "transcribing"],
			[3, "recording"],
		]);
	});

	it("never shows an older take's text on a new take", () => {
		const sections = buildStudioSections(snapshot({ recordingId: 2 }));
		expect(sections.map((section) => section.state)).toEqual(["waiting", "waiting"]);
		expect(studioTranscriptText(sections)).toBe("");
	});

	it("marks a transcribed clip without speech as silent, not waiting", () => {
		const value = snapshot();
		value.transcript.clips[1] = { index: 2, durationMs: 8_000, text: "", words: [], error: null };
		expect(buildStudioSections(value).map((section) => section.state)).toEqual(["text", "silent"]);
	});

	it("copies finished clips as paragraphs", () => {
		expect(studioTranscriptText(buildStudioSections(snapshot()))).toBe(
			"Hello there. How are you?\n\nOld cache text",
		);
	});
});

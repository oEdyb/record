import type { StudioSnapshot } from "../../../electron/studio/types";
import { buildPeekTimeline } from "../launch/HudClipPeek";

export interface StudioSentence {
	text: string;
	/** Where the sentence starts in the clip's screen video, in seconds. */
	clipSec: number;
	/** The same moment on the whole take's replay timeline. */
	takeSec: number;
	endTakeSec: number;
}

export type StudioSectionState = "text" | "recording" | "transcribing" | "waiting" | "error";

export interface StudioSection {
	clipIndex: number;
	/** Where the clip starts on the replay timeline. */
	startSec: number;
	state: StudioSectionState;
	sentences: StudioSentence[];
	error: string | null;
}

const SENTENCE_END = /[.?!…]["')\]]?$/;

/**
 * One section per kept clip, in take order, with its words grouped into sentences.
 * Word times are microphone time; the screen video starts `microphoneAudioOffsetMs`
 * earlier, so a sentence seeks to word time plus that offset.
 */
export function buildStudioSections(snapshot: StudioSnapshot): StudioSection[] {
	const timeline = buildPeekTimeline(snapshot.clips);
	// The transcriber keeps its last take until it runs again: clip 0 of an older take is not this one's.
	const ours = snapshot.transcript.recordingId === snapshot.recordingId;
	const byIndex = new Map(
		ours ? snapshot.transcript.clips.map((entry) => [entry.index, entry]) : [],
	);
	const transcribing = ours && snapshot.transcript.status === "transcribing";
	const sections: StudioSection[] = timeline.map(({ clip, start, duration }) => {
		const entry = byIndex.get(clip.index);
		const offsetSec = (clip.microphoneAudioOffsetMs ?? 0) / 1000;
		const at = (micSec: number) => Math.min(duration, Math.max(0, micSec + offsetSec));
		const sentences: StudioSentence[] = [];
		if (entry?.text?.trim()) {
			if (entry.words?.length) {
				let words: string[] = [];
				let first = 0;
				entry.words.forEach((word, i) => {
					if (words.length === 0) first = word.startSec;
					words.push(word.word);
					const last = i === entry.words!.length - 1;
					if (SENTENCE_END.test(word.word.trim()) || last) {
						sentences.push({
							text: words.join(" ").replace(/\s+([,.?!…])/g, "$1"),
							clipSec: at(first),
							takeSec: start + at(first),
							endTakeSec: start + at(word.endSec),
						});
						words = [];
					}
				});
			} else {
				// A cache from before word times: the whole clip seeks to its start.
				sentences.push({
					text: entry.text.trim(),
					clipSec: 0,
					takeSec: start,
					endTakeSec: start + duration,
				});
			}
		}
		const state: StudioSectionState = sentences.length
			? "text"
			: entry?.error
				? "error"
				: transcribing
					? "transcribing"
					: "waiting";
		return {
			clipIndex: clip.index,
			startSec: start,
			state,
			sentences,
			error: entry?.error ?? null,
		};
	});
	if (snapshot.phase === "recording") {
		const lastIndex = snapshot.clips.reduce((max, clip) => Math.max(max, clip.index), -1);
		const total = timeline.reduce((sum, entry) => sum + entry.duration, 0);
		sections.push({
			clipIndex: lastIndex + 1,
			startSec: total,
			state: "recording",
			sentences: [],
			error: null,
		});
	}
	return sections;
}

/** Plain text of every finished clip, one paragraph each, for the clipboard. */
export function studioTranscriptText(sections: readonly StudioSection[]): string {
	return sections
		.filter((section) => section.state === "text")
		.map((section) => section.sentences.map((sentence) => sentence.text).join(" "))
		.join("\n\n");
}

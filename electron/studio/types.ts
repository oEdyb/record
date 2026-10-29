import type { RecordingSessionClip } from "../../src/lib/recordingSession";
import type { TranscriptSnapshot } from "../transcript/liveTranscript";

/** Where the take stands, as the Studio shows it. */
export type StudioPhase = "idle" | "recording" | "paused";

export interface StudioSnapshot {
	phase: StudioPhase;
	recordingId: number | null;
	/** Committed kept clips in take order, with their screen, camera and microphone files. */
	clips: RecordingSessionClip[];
	/** Length of the committed kept clips. */
	committedMs: number;
	/** Wall-clock start of the clip being recorded now; null unless recording. */
	liveSinceMs: number | null;
	/**
	 * Recording would show the Studio, so it steps aside while capture runs. Known only
	 * while recording; false otherwise.
	 */
	hiddenForCapture: boolean;
	transcript: TranscriptSnapshot;
}

/** What the Studio asks for. Recording commands run through the pill's own handlers. */
export type StudioCommand = "pause" | "resume" | "stop" | "remove-last" | "pill";

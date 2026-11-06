import type { RecordingQuality } from "../../src/lib/recording/recordingQuality";
import type { CursorCaptureMode, RecordingSessionClip } from "../../src/lib/recordingSession";
import type { TranscriptSnapshot } from "../transcript/liveTranscript";

/**
 * Where the take stands, as the Studio shows it. `review` is a stopped take the Studio
 * keeps on screen for read-back before it is handed to export.
 */
export type StudioPhase = "idle" | "recording" | "paused" | "review";

/** The recording setup both the pill and the Studio show. Main owns it; the pill applies it. */
export interface StudioSetup {
	source: { id: string; name: string; kind: "display" | "window" } | null;
	micEnabled: boolean;
	micDeviceId: string | null;
	cameraEnabled: boolean;
	cameraDeviceId: string | null;
	systemAudioEnabled: boolean;
	cursorCaptureMode: CursorCaptureMode;
	recordingQuality: RecordingQuality;
}

/** What only the pill knows: its own locks and the clip it can still bring back. */
export interface StudioPillState {
	/** Setup changes are refused now (counting down, starting, finalizing a clip). */
	controlsLocked: boolean;
	/** The pill's own predicate for Remove previous clip. */
	canRemovePreviousClip: boolean;
	/** A clip removal that Undo can still reverse, by its clip index. */
	undoClipIndex: number | null;
	/** The countdown before capture is running. */
	countingDown: boolean;
	/** Stop was pressed and the take is being saved. */
	saving: boolean;
	/** A clip is finalizing or the take is saving; Pause, Stop and Remove wait for it. */
	transportBusy: boolean;
	/** The pill's own predicate for Pause/Continue. */
	canPause: boolean;
}

export const IDLE_PILL_STATE: StudioPillState = {
	controlsLocked: false,
	canRemovePreviousClip: false,
	undoClipIndex: null,
	countingDown: false,
	saving: false,
	transportBusy: false,
	canPause: false,
};

export interface StudioSnapshot {
	clipEdits?: "ready" | "needs-recovery";
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
	/** Capture runs or is about to: replay stays paused so its sound is not recorded. */
	holdPlayback: boolean;
	/** The window is on screen. Hidden, the replay stops and lets go of its media. */
	shown: boolean;
	transcript: TranscriptSnapshot;
	setup: StudioSetup;
	pill: StudioPillState;
}

/** Commands without a value. Recording and setup commands run through the pill's own handlers. */
export type StudioSimpleCommand =
	| "record"
	| "pause"
	| "resume"
	| "stop"
	| "remove-last"
	| "undo-remove"
	| "pill"
	| "toggle-mic"
	| "toggle-camera"
	| "toggle-system-audio"
	| "choose-source"
	| "open-notes"
	| "cancel-countdown"
	| "record-more"
	| "finish";

export type StudioCommand =
	| StudioSimpleCommand
	| { kind: "select-mic"; deviceId: string; name: string }
	| { kind: "select-camera"; deviceId: string; name: string }
	| { kind: "set-quality"; value: RecordingQuality }
	| { kind: "set-cursor"; value: CursorCaptureMode };

/** A setup or undo command the pill applies with its own handlers and predicates. */
export type PillSetupCommand = Exclude<
	StudioCommand,
	"record" | "pause" | "resume" | "stop" | "remove-last" | "pill" | "record-more" | "finish"
>;

export type StudioRecordResult =
	| { success: true; recordingId: number }
	| { success: false; error: string };

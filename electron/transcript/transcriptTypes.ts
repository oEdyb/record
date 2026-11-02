import type { TranscriptWord } from "./parakeetProcess";

export interface TranscriptClipSource {
	index: number;
	microphoneAudioPath: string;
	durationMs: number;
}

export interface TranscriptClipListing {
	recordingId: number | null;
	clips: TranscriptClipSource[];
	/** A take is running and not paused: transcribing now would compete with capture. */
	live: boolean;
}

export interface TranscriptClipEntry {
	index: number;
	durationMs: number;
	text: string | null;
	/** Clip-relative word times; null until transcribed, or for a cache written before word times. */
	words: TranscriptWord[] | null;
	error: string | null;
}

export type TranscriptStatus = "idle" | "downloading-model" | "transcribing" | "blocked";

export interface TranscriptSnapshot {
	recordingId: number | null;
	clips: TranscriptClipEntry[];
	status: TranscriptStatus;
	/** Clips finished of clips pending in the current pass. */
	progress: { done: number; total: number } | null;
	download: { downloadedBytes: number; totalBytes: number } | null;
	error: string | null;
	updatedAt: number;
}

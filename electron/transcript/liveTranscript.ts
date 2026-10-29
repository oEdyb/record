import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { extractMicrophoneWav } from "./microphoneWav";
import { ParakeetProcess, type TranscriptWord } from "./parakeetProcess";
import {
	type ClipTranscript,
	cacheKey,
	readTranscriptCache,
	writeTranscriptCache,
} from "./transcriptCache";

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

export interface LiveTranscriptDeps {
	listClips: () => TranscriptClipListing;
	ffmpegPath: () => string | null;
	helperPath: () => string | null;
	/** Resolves to the Parakeet model directory, downloading it first when missing. */
	ensureModel: (
		onProgress: (downloadedBytes: number, totalBytes: number) => void,
	) => Promise<string>;
	/** Whether the model is already on disk; automatic passes never start a download. */
	modelReady?: () => boolean;
	tempDir: string;
	cacheDir: string;
	onSnapshot?: (snapshot: TranscriptSnapshot) => void;
	now?: () => number;
	transcriber?: (
		helperPath: string,
		modelDir: string,
	) => Pick<ParakeetProcess, "transcribe" | "stop">;
	extract?: typeof extractMicrophoneWav;
}

/**
 * Transcribes the committed microphone clips of the current take on request, newest
 * clips only. Text is cached per clip in memory and on disk, so a second request after
 * one more clip costs one clip. Originals are read, never written.
 */
export class LiveTranscriptService {
	private texts = new Map<string, ClipTranscript>();
	private loadedCacheFor: number | null | undefined;
	private helper: Pick<ParakeetProcess, "transcribe" | "stop"> | null = null;
	private inFlight: Promise<TranscriptSnapshot> | null = null;
	private rerun: Promise<TranscriptSnapshot> | null = null;
	/** Bumped when capture resumes, so a clip cut short reads as unfinished rather than failed. */
	private generation = 0;
	private lastListing: TranscriptClipListing = { recordingId: null, clips: [], live: false };
	private current: TranscriptSnapshot = {
		recordingId: null,
		clips: [],
		status: "idle",
		progress: null,
		download: null,
		error: null,
		updatedAt: 0,
	};

	constructor(private readonly deps: LiveTranscriptDeps) {}

	snapshot(): TranscriptSnapshot {
		return this.current;
	}

	/**
	 * Runs at most one pass at a time. A request during a pass queues one more pass after
	 * it, so a clip that finished meanwhile is never skipped.
	 */
	refresh(): Promise<TranscriptSnapshot> {
		if (this.inFlight) {
			this.rerun ??= this.inFlight.then(() => {
				this.rerun = null;
				return this.refresh();
			});
			return this.rerun;
		}
		this.inFlight = this.run().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	/** After a clip finishes. Null when the model is not on disk: never a surprise download. */
	refreshAfterClip(): Promise<TranscriptSnapshot> | null {
		if (this.deps.modelReady && !this.deps.modelReady()) return null;
		return this.refresh();
	}

	/** The take just stopped: keep its clips, since the recorder forgets them right after. */
	rememberStoppedTake(listing: TranscriptClipListing) {
		if (listing.clips.length > 0) this.lastListing = { ...listing, live: false };
	}

	/** Capture is resuming: end the clip in progress now instead of competing with it. */
	interrupt() {
		this.generation += 1;
		this.stop();
	}

	stop() {
		this.helper?.stop();
		this.helper = null;
	}

	private listing(): TranscriptClipListing {
		const listing = this.deps.listClips();
		// After Stop the recorder forgets its take; keep showing the last one that had clips.
		if (listing.clips.length > 0 || listing.recordingId !== null) this.lastListing = listing;
		return this.lastListing;
	}

	private publish(partial: Partial<TranscriptSnapshot>) {
		this.current = { ...this.current, ...partial, updatedAt: (this.deps.now ?? Date.now)() };
		this.deps.onSnapshot?.(this.current);
	}

	private entries(
		listing: TranscriptClipListing,
		errors: Map<number, string>,
	): TranscriptClipEntry[] {
		return listing.clips.map((clip) => {
			const transcript = this.texts.get(cacheKey(listing.recordingId, clip));
			return {
				index: clip.index,
				durationMs: clip.durationMs,
				text: transcript?.text ?? null,
				words: transcript?.words ?? null,
				error: errors.get(clip.index) ?? null,
			};
		});
	}

	private async run(): Promise<TranscriptSnapshot> {
		const generation = this.generation;
		const listing = this.listing();
		const errors = new Map<number, string>();
		await this.loadCache(listing.recordingId);
		const pending = listing.clips.filter(
			(clip) => !this.texts.has(cacheKey(listing.recordingId, clip)),
		);
		if (listing.live && pending.length > 0) {
			this.publish({
				recordingId: listing.recordingId,
				clips: this.entries(listing, errors),
				status: "blocked",
				progress: null,
				download: null,
				error: null,
			});
			return this.current;
		}
		if (pending.length === 0) {
			this.publish({
				recordingId: listing.recordingId,
				clips: this.entries(listing, errors),
				status: "idle",
				progress: null,
				download: null,
				error: null,
			});
			return this.current;
		}

		try {
			const ffmpeg = this.deps.ffmpegPath();
			if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable.");
			const helperPath = this.deps.helperPath();
			if (!helperPath)
				throw new Error(
					process.platform === "linux"
						? "Transcription's speech helper is missing from this build."
						: "Transcription needs an Apple Silicon Mac on macOS 14 or newer.",
				);
			this.publish({
				recordingId: listing.recordingId,
				clips: this.entries(listing, errors),
				status: "transcribing",
				progress: { done: 0, total: pending.length },
				download: null,
				error: null,
			});
			const modelDir = await this.deps.ensureModel((downloadedBytes, totalBytes) => {
				this.publish({ status: "downloading-model", download: { downloadedBytes, totalBytes } });
			});
			this.helper ??= (
				this.deps.transcriber ??
				((binaryPath, dir) => new ParakeetProcess({ binaryPath, modelDir: dir }))
			)(helperPath, modelDir);
			await mkdir(this.deps.tempDir, { recursive: true });
			let done = 0;
			for (const clip of pending) {
				// Continue during a pass: interrupt() ends the clip in progress, never transcribe alongside capture.
				if (generation !== this.generation || this.deps.listClips().live) {
					await this.saveCache(listing);
					this.publish({
						clips: this.entries(listing, errors),
						status: "blocked",
						progress: null,
						download: null,
					});
					return this.current;
				}
				const wavPath = path.join(
					this.deps.tempDir,
					`transcript-${listing.recordingId ?? "x"}-${clip.index}.wav`,
				);
				try {
					await (this.deps.extract ?? extractMicrophoneWav)(
						ffmpeg,
						clip.microphoneAudioPath,
						wavPath,
					);
					const result = await this.helper.transcribe({
						id: `clip-${clip.index}`,
						audioPath: wavPath,
					});
					this.texts.set(cacheKey(listing.recordingId, clip), {
						text: result.text,
						words: result.words,
					});
				} catch (error) {
					// Cut short by a resume: unfinished, not failed; the next pause picks it up.
					if (generation === this.generation)
						errors.set(clip.index, error instanceof Error ? error.message : String(error));
				} finally {
					await rm(wavPath, { force: true }).catch(() => undefined);
				}
				done += 1;
				this.publish({
					clips: this.entries(listing, errors),
					status: "transcribing",
					progress: { done, total: pending.length },
					download: null,
				});
			}
			await this.saveCache(listing);
			this.publish({ clips: this.entries(listing, errors), status: "idle", progress: null });
		} catch (error) {
			this.publish({
				clips: this.entries(listing, errors),
				status: "idle",
				progress: null,
				download: null,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return this.current;
	}

	private async loadCache(recordingId: number | null) {
		if (this.loadedCacheFor === recordingId) return;
		this.loadedCacheFor = recordingId;
		for (const [key, clip] of await readTranscriptCache(this.deps.cacheDir, recordingId))
			this.texts.set(key, clip);
	}

	private async saveCache(listing: TranscriptClipListing) {
		const entries: Record<string, ClipTranscript> = {};
		for (const clip of listing.clips) {
			const key = cacheKey(listing.recordingId, clip);
			const text = this.texts.get(key);
			if (text !== undefined) entries[key] = text;
		}
		await writeTranscriptCache(this.deps.cacheDir, listing.recordingId, entries);
	}
}

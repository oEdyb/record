import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractMicrophoneWav } from "./microphoneWav";
import { ParakeetProcess } from "./parakeetProcess";

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

function cacheKey(recordingId: number | null, clip: TranscriptClipSource): string {
	return `${recordingId ?? "none"}:${clip.index}:${clip.microphoneAudioPath}`;
}

/**
 * Transcribes the committed microphone clips of the current take on request, newest
 * clips only. Text is cached per clip in memory and on disk, so a second request after
 * one more clip costs one clip. Originals are read, never written.
 */
export class LiveTranscriptService {
	private texts = new Map<string, string>();
	private loadedCacheFor: number | null | undefined;
	private helper: Pick<ParakeetProcess, "transcribe" | "stop"> | null = null;
	private inFlight: Promise<TranscriptSnapshot> | null = null;
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

	/** Runs at most one pass at a time; a request during a pass gets that pass's result. */
	refresh(): Promise<TranscriptSnapshot> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.run().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
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
		return listing.clips.map((clip) => ({
			index: clip.index,
			durationMs: clip.durationMs,
			text: this.texts.get(cacheKey(listing.recordingId, clip)) ?? null,
			error: errors.get(clip.index) ?? null,
		}));
	}

	private async run(): Promise<TranscriptSnapshot> {
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
				throw new Error("Transcription needs an Apple Silicon Mac on macOS 14 or newer.");
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
				// Continue during a pass: finish this clip at most, never transcribe alongside capture.
				if (this.deps.listClips().live) {
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
					this.texts.set(cacheKey(listing.recordingId, clip), result.text);
				} catch (error) {
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

	private cachePath(recordingId: number | null): string {
		return path.join(this.deps.cacheDir, `${recordingId ?? "none"}.json`);
	}

	private async loadCache(recordingId: number | null) {
		if (this.loadedCacheFor === recordingId) return;
		this.loadedCacheFor = recordingId;
		try {
			const raw = JSON.parse(await readFile(this.cachePath(recordingId), "utf8")) as unknown;
			if (raw && typeof raw === "object") {
				for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
					if (typeof value === "string") this.texts.set(key, value);
				}
			}
		} catch {
			// No cache yet, or an unreadable one: transcribe again.
		}
	}

	private async saveCache(listing: TranscriptClipListing) {
		const entries: Record<string, string> = {};
		for (const clip of listing.clips) {
			const key = cacheKey(listing.recordingId, clip);
			const text = this.texts.get(key);
			if (text !== undefined) entries[key] = text;
		}
		try {
			await mkdir(this.deps.cacheDir, { recursive: true });
			await writeFile(this.cachePath(listing.recordingId), JSON.stringify(entries));
		} catch {
			// The cache is a convenience; losing it only costs a re-run.
		}
	}
}

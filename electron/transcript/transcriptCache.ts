import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TranscriptWord } from "./parakeetProcess";

/** One clip's text, with clip-relative word times when the cache has them. */
export interface ClipTranscript {
	text: string;
	words: TranscriptWord[] | null;
}

function isWord(value: unknown): value is TranscriptWord {
	if (!value || typeof value !== "object") return false;
	const word = value as Record<string, unknown>;
	return (
		typeof word.word === "string" &&
		typeof word.startSec === "number" &&
		typeof word.endSec === "number" &&
		typeof word.confidence === "number"
	);
}

function readCachedClip(value: unknown): ClipTranscript | null {
	if (typeof value === "string") return { text: value, words: null };
	if (!value || typeof value !== "object") return null;
	const entry = value as Record<string, unknown>;
	if (typeof entry.text !== "string") return null;
	const words = Array.isArray(entry.words) && entry.words.every(isWord) ? entry.words : null;
	return { text: entry.text, words };
}

export function cacheKey(
	recordingId: number | null,
	clip: { index: number; microphoneAudioPath: string },
): string {
	return `${recordingId ?? "none"}:${clip.index}:${clip.microphoneAudioPath}`;
}

function cachePath(cacheDir: string, recordingId: number | null): string {
	return path.join(cacheDir, `${recordingId ?? "none"}.json`);
}

/** A take's cached clips by cache key; empty when there is no cache or it is unreadable. */
export async function readTranscriptCache(
	cacheDir: string,
	recordingId: number | null,
): Promise<Map<string, ClipTranscript>> {
	const clips = new Map<string, ClipTranscript>();
	try {
		const raw = JSON.parse(await readFile(cachePath(cacheDir, recordingId), "utf8")) as unknown;
		if (raw && typeof raw === "object") {
			for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
				const clip = readCachedClip(value);
				if (clip) clips.set(key, clip);
			}
		}
	} catch {
		// No cache yet, or an unreadable one: transcribe again.
	}
	return clips;
}

export async function writeTranscriptCache(
	cacheDir: string,
	recordingId: number | null,
	entries: Record<string, ClipTranscript>,
) {
	try {
		await mkdir(cacheDir, { recursive: true });
		await writeFile(cachePath(cacheDir, recordingId), JSON.stringify(entries));
	} catch {
		// The cache is a convenience; losing it only costs a re-run.
	}
}

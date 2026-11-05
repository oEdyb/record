import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
	normalizeRecordingSession,
	type RecordingSession,
	type RecordingSessionClip,
} from "../../src/lib/recordingSession";
import { inspectHandoffSourceMedia } from "../export/sourceHandoffMedia";
import { writeJsonDurably } from "../filesystem/durableJson";
import { reindexRecordingOnDisk } from "./webm-seek-index";

export type NativeMacRecoveredSession = RecordingSession & { recoveryWarnings?: string[] };

const ORIGINAL_FIELDS = [
	["webcamVideoPath", "webcamOffsetMs", "webcam", "video"],
	["microphoneAudioPath", "microphoneAudioOffsetMs", "microphone", "audio"],
	["systemAudioPath", "systemAudioOffsetMs", "system", "audio"],
] as const;

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_SUFFIX = ".recovery.json";

type NativeMacRecoveryEnvelope = {
	schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
	session: RecordingSession;
};

export function nativeMacRecoveryJournalPath(recordingsDir: string, recordingId: number): string {
	return path.join(recordingsDir, `recording-${recordingId}${JOURNAL_SUFFIX}`);
}

export async function persistNativeMacRecoveryJournal(
	recordingsDir: string,
	session: RecordingSession,
): Promise<void> {
	const normalized = normalizeRecordingSession(session);
	if (!normalized) throw new Error("Cannot persist an invalid native recovery session.");
	const envelope: NativeMacRecoveryEnvelope = {
		schemaVersion: JOURNAL_SCHEMA_VERSION,
		session: normalized,
	};
	await writeJsonDurably(
		nativeMacRecoveryJournalPath(recordingsDir, normalized.createdAt),
		envelope,
	);
}

export async function updateNativeMacRecoveryJournalIfPresent(
	recordingsDir: string,
	session: RecordingSession,
): Promise<void> {
	const journalPath = nativeMacRecoveryJournalPath(recordingsDir, session.createdAt);
	const exists = await fs
		.stat(journalPath)
		.then((stats) => stats.isFile())
		.catch(() => false);
	if (exists) await persistNativeMacRecoveryJournal(recordingsDir, session);
}

export async function clearNativeMacRecoveryJournal(
	recordingsDir: string,
	recordingId: number,
): Promise<void> {
	try {
		await fs.unlink(nativeMacRecoveryJournalPath(recordingsDir, recordingId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (process.platform === "win32") return;
	let directoryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		directoryHandle = await fs.open(recordingsDir, "r");
		await directoryHandle.sync();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	} finally {
		await directoryHandle?.close().catch(() => undefined);
	}
}

async function readableSize(filePath: string): Promise<number | null> {
	try {
		const stats = await fs.stat(filePath);
		return stats.isFile() ? stats.size : null;
	} catch {
		return null;
	}
}

async function discoverUnjournaledClips(
	recordingsDir: string,
	session: RecordingSession,
): Promise<RecordingSessionClip[]> {
	const knownIndices = new Set((session.clips ?? []).map((clip) => clip.index));
	const prefix = `recording-${session.createdAt}-clip-`;
	let entries: Dirent[];
	try {
		entries = await fs.readdir(recordingsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const discovered: RecordingSessionClip[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const match = new RegExp(`^${prefix}(\\d{4})\\.mp4$`).exec(entry.name);
		if (!match) continue;
		const index = Number(match[1]) - 1;
		if (index < 0 || knownIndices.has(index)) continue;
		const screenVideoPath = path.join(recordingsDir, entry.name);
		const size = await readableSize(screenVideoPath);
		if (size === null || size === 0) continue;
		discovered.push({
			index,
			screenVideoPath,
			durationMs: 60_000,
			provisionalDuration: true,
			cursorCaptureMode: session.cursorCaptureMode,
		});
	}
	return discovered;
}

async function recoverSession(
	recordingsDir: string,
	session: RecordingSession,
	inspectOriginal = inspectHandoffSourceMedia,
): Promise<NativeMacRecoveredSession | null> {
	const recoveredClips: RecordingSessionClip[] = [];
	const recoveryWarnings: string[] = [];
	const candidates = [
		...(session.clips ?? []),
		...(await discoverUnjournaledClips(recordingsDir, session)),
	].sort((left, right) => left.index - right.index);
	for (const clip of candidates) {
		if (clip.removed) {
			recoveredClips.push(clip);
			continue;
		}
		const size = await readableSize(clip.screenVideoPath);
		const readable = size !== null && size > 0;
		if (!readable) {
			recoveredClips.push({ ...clip, removed: true });
			continue;
		}
		let recoveredDurationMs = clip.durationMs;
		if (clip.provisionalDuration) {
			try {
				const media = await inspectHandoffSourceMedia(clip.screenVideoPath);
				if (
					!media.video ||
					!media.durationSec ||
					!Number.isFinite(media.durationSec) ||
					media.durationSec <= 0
				)
					throw new Error("no readable video duration");
				recoveredDurationMs = Math.max(1, Math.round(media.durationSec * 1000));
			} catch (error) {
				// An unavailable inspector or timeout proves nothing about the media.
				// Keep unknown tails provisional so the renderer can probe them and offer
				// its retained-handoff retry if that independent probe also fails.
				const message = error instanceof Error ? error.message : String(error);
				if (error instanceof Error && /moov atom not found(?:\r?\n|$)/.test(message)) {
					// Retain the path and bytes; exclude only this confirmed missing header.
					recoveredClips.push({ ...clip, removed: true });
					recoveryWarnings.push(
						`The unfinished screen clip ${clip.index + 1} could not be opened. Its file is retained: ${message}`,
					);
					continue;
				}
				recoveryWarnings.push(
					`The unfinished screen clip ${clip.index + 1} still needs a playback check: ${message}`,
				);
			}
		}
		const recovered = { ...clip, durationMs: recoveredDurationMs };
		for (const [field, offsetField, suffix, mediaType] of ORIGINAL_FIELDS) {
			const originalPath = clip[field];
			if (!originalPath) continue;
			delete recovered[field];
			delete recovered[offsetField];
			try {
				const stem = path.join(
					recordingsDir,
					`recording-${session.createdAt}-clip-${String(clip.index + 1).padStart(4, "0")}`,
				);
				const extension = path.extname(originalPath);
				if (
					!(
						(mediaType === "video" && [".mov", ".webm", ".mp4"].includes(extension)) ||
						(mediaType === "audio" && [".mov", ".m4a", ".mp4"].includes(extension))
					) ||
					path.resolve(originalPath) !== `${stem}-${suffix}${extension}`
				)
					throw new Error("unowned source path");
				const stats = await fs.lstat(originalPath);
				if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0)
					throw new Error("empty or missing source");
				const offsetMs = clip[offsetField];
				if (typeof offsetMs !== "number" || !Number.isFinite(offsetMs) || offsetMs < 0)
					throw new Error("missing captured source timing");
				const media = await inspectOriginal(originalPath);
				if (
					!media.durationSec ||
					!Number.isFinite(media.durationSec) ||
					media.durationSec <= 0 ||
					(mediaType === "video" ? !media.video : !media.hasAudio)
				)
					throw new Error("unreadable source media");
				recovered[field] = originalPath;
				recovered[offsetField] = offsetMs;
			} catch (error) {
				recoveryWarnings.push(
					`The ${suffix} original for clip ${clip.index + 1} could not be recovered: ${error instanceof Error ? error.message : String(error)}.`,
				);
			}
		}
		recoveredClips.push(recovered);
	}

	const firstKept = recoveredClips.find((clip) => !clip.removed);
	if (firstKept) {
		return {
			...session,
			screenVideoPath: firstKept.screenVideoPath,
			clips: recoveredClips,
			schemaVersion: 2,
			...(recoveryWarnings.length > 0
				? {
						recoveryWarnings,
						interruption: session.interruption ?? {
							code: "capture-recovery-incomplete",
							message: recoveryWarnings.join(" ").slice(0, 2000),
						},
					}
				: {}),
		};
	}

	// A clip-native journal is authoritative even when every finalized clip was
	// removed. Falling through to the legacy anchor would resurrect clip 1.
	if (session.schemaVersion === 2) return null;

	const fallbackSize = await readableSize(session.screenVideoPath);
	if (fallbackSize === null || fallbackSize === 0) return null;
	const { clips: _clips, schemaVersion: _schemaVersion, ...legacySession } = session;
	return {
		...legacySession,
	};
}

async function readRecoverySession(filePath: string): Promise<RecordingSession | null> {
	try {
		const envelope = JSON.parse(
			await fs.readFile(filePath, "utf-8"),
		) as Partial<NativeMacRecoveryEnvelope>;
		if (envelope.schemaVersion !== JOURNAL_SCHEMA_VERSION) return null;
		return normalizeRecordingSession(envelope.session);
	} catch {
		return null;
	}
}

/**
 * True when the helper's final clips already hold every clip and original the
 * journal knows about, so restoring the journal could add nothing.
 */
export async function nativeMacJournalCoveredBy(
	recordingsDir: string,
	recordingId: number,
	clips: RecordingSessionClip[],
): Promise<boolean> {
	const journal = await readRecoverySession(
		nativeMacRecoveryJournalPath(recordingsDir, recordingId),
	);
	if (!journal) return true;
	return (journal.clips ?? []).every((journaled) => {
		if (journaled.removed) return true;
		const known = clips.find((clip) => clip.index === journaled.index);
		return Boolean(known && ORIGINAL_FIELDS.every(([field]) => !journaled[field] || known[field]));
	});
}

export async function restoreNativeMacRecoverySession(
	recordingsDir: string,
	recordingId: number,
): Promise<NativeMacRecoveredSession | null> {
	const session = await readRecoverySession(
		nativeMacRecoveryJournalPath(recordingsDir, recordingId),
	);
	return session ? recoverSession(recordingsDir, session) : null;
}

export async function restoreLatestNativeMacRecoverySession(
	recordingsDir: string,
): Promise<NativeMacRecoveredSession | null> {
	let entries: string[];
	try {
		entries = await fs.readdir(recordingsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}

	const candidates: RecordingSession[] = [];
	for (const entry of entries.filter((name) => name.endsWith(JOURNAL_SUFFIX))) {
		const session = await readRecoverySession(path.join(recordingsDir, entry));
		if (session) candidates.push(session);
	}

	candidates.sort((left, right) => right.createdAt - left.createdAt);
	for (const candidate of candidates) {
		const recovered = await recoverSession(recordingsDir, candidate, inspectCrashedOriginal);
		if (recovered) return recovered;
	}
	return null;
}

/** Startup owns these files exclusively. Live Stop must never replace a camera
 * file while the renderer's write stream still points at its current inode. */
async function inspectCrashedOriginal(sourcePath: string) {
	const media = await inspectHandoffSourceMedia(sourcePath);
	if (path.extname(sourcePath) !== ".webm" || !media.video || media.durationSec !== null)
		return media;
	const repaired = await reindexRecordingOnDisk(sourcePath);
	return repaired.reindexed ? inspectHandoffSourceMedia(sourcePath) : media;
}

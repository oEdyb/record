import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
	normalizeRecordingSession,
	type RecordingSession,
	type RecordingSessionClip,
} from "../../src/lib/recordingSession";
import { writeJsonDurably } from "../filesystem/durableJson";

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
	if (!normalized) throw new Error("Cannot persist an invalid native macOS recovery session.");
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
): Promise<RecordingSession | null> {
	const recoveredClips: RecordingSessionClip[] = [];
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
		recoveredClips.push(readable ? clip : { ...clip, removed: true });
	}

	const firstKept = recoveredClips.find((clip) => !clip.removed);
	if (firstKept) {
		return {
			...session,
			screenVideoPath: firstKept.screenVideoPath,
			clips: recoveredClips,
			schemaVersion: 2,
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

export async function restoreNativeMacRecoverySession(
	recordingsDir: string,
	recordingId: number,
): Promise<RecordingSession | null> {
	const session = await readRecoverySession(
		nativeMacRecoveryJournalPath(recordingsDir, recordingId),
	);
	return session ? recoverSession(recordingsDir, session) : null;
}

export async function restoreLatestNativeMacRecoverySession(
	recordingsDir: string,
): Promise<RecordingSession | null> {
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
		const recovered = await recoverSession(recordingsDir, candidate);
		if (recovered) return recovered;
	}
	return null;
}

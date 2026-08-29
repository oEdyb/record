import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VOICEOVER_TEMP_PATTERN =
	/^\.klippt-voiceover-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/i;

export function createVoiceoverTempPath(tempDirectory: string, ownerPid = process.pid): string {
	return path.join(tempDirectory, `.klippt-voiceover-${ownerPid}-${randomUUID()}.mp4`);
}

function voiceoverTempOwnerPid(filePath: string): number | null {
	const match = path.basename(filePath).match(VOICEOVER_TEMP_PATTERN);
	if (!match) return null;
	const ownerPid = Number(match[1]);
	return Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function isVoiceoverTempPath(
	tempDirectory: string,
	filePath: string,
	ownerPid = process.pid,
): boolean {
	const normalizedDirectory = path.resolve(tempDirectory);
	const normalizedPath = path.resolve(filePath);
	return (
		path.dirname(normalizedPath) === normalizedDirectory &&
		voiceoverTempOwnerPid(normalizedPath) === ownerPid
	);
}

/** Removes only Klippt-owned voiceover intermediates left by an earlier process. */
export async function cleanupOrphanedVoiceoverTemps(
	tempDirectory: string,
	isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
): Promise<number> {
	const entries = await fs.readdir(tempDirectory, { withFileTypes: true }).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(tempDirectory, entry.name);
		const ownerPid = voiceoverTempOwnerPid(filePath);
		if (ownerPid === null || isProcessAlive(ownerPid)) continue;
		await fs.rm(filePath, { force: true });
		removed += 1;
	}
	return removed;
}

import fs from "node:fs/promises";
import os from "node:os";
import { availableBytes, ExportTransactionError, formatGigabytes } from "./atomicExport";

/** 48 kHz stereo 32-bit float, as `crates/compositor/src/audio_spool.rs` stores it. */
const SPOOL_BYTES_PER_SEC = 48_000 * 8;
const SPOOL_SAFETY_BYTES = 256 * 1024 * 1024;

/** Peak PCM scratch space of a rendered export. Each take decodes up to two
 * source tracks and keeps a mixed bed and microphone until the program is
 * assembled, so the peak is the larger of three program lengths and two
 * program lengths plus the longest take's two decoded tracks. */
export function audioSpoolPeakBytes(takeDurationsSec: number[]): number {
	const total = takeDurationsSec.reduce((sum, seconds) => sum + Math.max(0, seconds), 0);
	const longest = Math.max(0, ...takeDurationsSec);
	return Math.ceil(Math.max(3 * total, 2 * total + 2 * longest) * SPOOL_BYTES_PER_SEC);
}

/** Audio scratch files go to the temp directory on the startup disk, which the
 * destination's space check does not cover. Refuse before rendering any video. */
export async function assertAudioSpoolSpace(
	takeDurationsSec: number[],
	directory = os.tmpdir(),
	getAvailableBytes: (directory: string) => Promise<bigint> = async (path) =>
		availableBytes(await fs.statfs(path)),
): Promise<void> {
	const needed = BigInt(audioSpoolPeakBytes(takeDurationsSec) + SPOOL_SAFETY_BYTES);
	const free = await getAvailableBytes(directory);
	if (free < needed)
		throw new ExportTransactionError(
			`Not enough free space on the startup disk to prepare this export's audio. It needs about ${formatGigabytes(needed)} free, and the disk has ${formatGigabytes(free)}.`,
			"preflight",
			"INSUFFICIENT_SPACE",
			true,
		);
}

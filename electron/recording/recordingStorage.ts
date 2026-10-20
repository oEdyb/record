import fs from "node:fs/promises";

/** Below this a take does not start: a High screen alone can write about 17 MB/s. */
export const MINIMUM_START_FREE_BYTES = 1024 ** 3;
/** Below this a live take pauses, leaving room to close the clip and save the session. */
export const PAUSE_FREE_BYTES = 512 * 1024 ** 2;
export const STORAGE_POLL_MS = 5_000;
const WARNING_MINUTES = [5, 1] as const;

export type RecordingStorageStatus = { freeBytes: number; minutesLeft: number | null };

export async function freeDiskBytes(directory: string): Promise<number> {
	const stats = await fs.statfs(directory);
	return stats.bavail * stats.bsize;
}

export function storageStartError(freeBytes: number): string | null {
	if (freeBytes >= MINIMUM_START_FREE_BYTES) return null;
	return `Only ${formatBytes(freeBytes)} free on the recordings disk. Free at least ${formatBytes(MINIMUM_START_FREE_BYTES)} to record.`;
}

export function formatBytes(bytes: number): string {
	return bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GB`
		: `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * Watches free space during a take. It warns once as each of 5 and 1 minutes left at the
 * measured write rate is crossed, and asks for a Pause before the writer can hit a full disk.
 */
export class RecordingStorageMonitor {
	private timer: ReturnType<typeof setInterval> | null = null;
	private previous: { freeBytes: number; atMs: number } | null = null;
	private bytesPerMs: number | null = null;
	private warned = new Set<number>();
	private pauseRequested = false;
	private polling = false;

	constructor(
		private readonly deps: {
			directory: string;
			now: () => number;
			freeBytes: (directory: string) => Promise<number>;
			onLow: (status: RecordingStorageStatus) => void;
			onCritical: (status: RecordingStorageStatus) => void;
		},
	) {}

	start(): void {
		this.stop();
		this.timer = setInterval(() => void this.poll(), STORAGE_POLL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.previous = null;
		this.bytesPerMs = null;
		this.warned.clear();
		this.pauseRequested = false;
	}

	/** Pausing writes nothing, so free space can be re-armed for the next clip. */
	rearm(): void {
		this.pauseRequested = false;
		this.previous = null;
	}

	async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			const freeBytes = await this.deps.freeBytes(this.deps.directory);
			const atMs = this.deps.now();
			if (this.previous && atMs > this.previous.atMs) {
				const rate = Math.max(
					0,
					(this.previous.freeBytes - freeBytes) / (atMs - this.previous.atMs),
				);
				this.bytesPerMs = this.bytesPerMs === null ? rate : this.bytesPerMs * 0.7 + rate * 0.3;
			}
			this.previous = { freeBytes, atMs };
			const minutesLeft =
				this.bytesPerMs && this.bytesPerMs > 0
					? Math.max(0, (freeBytes - PAUSE_FREE_BYTES) / this.bytesPerMs / 60_000)
					: null;
			const status = { freeBytes, minutesLeft };
			if (freeBytes < PAUSE_FREE_BYTES) {
				if (!this.pauseRequested) {
					this.pauseRequested = true;
					this.deps.onCritical(status);
				}
				return;
			}
			if (minutesLeft === null) return;
			const crossed = WARNING_MINUTES.filter(
				(limit) => minutesLeft <= limit && !this.warned.has(limit),
			);
			if (crossed.length === 0) return;
			for (const limit of crossed) this.warned.add(limit);
			this.deps.onLow(status);
		} catch (error) {
			console.warn("[capture-mac] could not read free disk space:", error);
		} finally {
			this.polling = false;
		}
	}
}

/** The slice of Electron's `powerSaveBlocker` the lock needs. */
export type PowerSaveBlocker = {
	start(type: "prevent-display-sleep"): number;
	stop(id: number): void;
};

/**
 * Keeps the display awake while a take is recording.
 *
 * macOS gets this from the capture helper itself (`RecordingProcessActivity`,
 * `.idleDisplaySleepDisabled`). The Linux helper has no equivalent, so without
 * this an idle timeout blanks or locks the session in the middle of a take: the
 * portal stream goes black or stops, and the take records the lock screen.
 * Electron routes `prevent-display-sleep` to the session's idle-inhibit service.
 *
 * Linux only: macOS already holds its own activity, and other platforms are out
 * of scope for this lock.
 */
export class RecordingWakeLock {
	private blockerId: number | null = null;

	constructor(
		private readonly platform: string,
		private readonly blocker: PowerSaveBlocker,
		private readonly onError: (error: unknown) => void = () => undefined,
	) {}

	get held(): boolean {
		return this.blockerId !== null;
	}

	/** Idempotent: the recording state callback fires for every start and stop. */
	set(recording: boolean): void {
		if (this.platform !== "linux") return;
		if (recording) this.acquire();
		else this.release();
	}

	private acquire(): void {
		if (this.blockerId !== null) return;
		try {
			this.blockerId = this.blocker.start("prevent-display-sleep");
		} catch (error) {
			// A missing inhibit service must never fail the take it was meant to protect.
			this.onError(error);
		}
	}

	private release(): void {
		if (this.blockerId === null) return;
		const id = this.blockerId;
		this.blockerId = null;
		try {
			this.blocker.stop(id);
		} catch (error) {
			this.onError(error);
		}
	}
}

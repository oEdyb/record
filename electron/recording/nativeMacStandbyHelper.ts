import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** The helper exits after 10 idle minutes; never hand over one that is about to. */
export const STANDBY_HELPER_MAX_AGE_MS = 540_000;
/** How often main checks that a fresh standby helper is ready while nothing records. */
export const STANDBY_HELPER_REWARM_INTERVAL_MS = 60_000;

type Standby = { process: ChildProcessWithoutNullStreams; helperPath: string; spawnedAt: number };

/**
 * One warmed-up capture helper, spawned before Record is clicked. It has loaded
 * the capture frameworks but captures nothing until it receives a request.
 */
export class NativeMacStandbyHelper {
	private standby: Standby | null = null;
	private warmCamera: unknown = null;

	constructor(
		private readonly deps: {
			spawn: (helperPath: string) => ChildProcessWithoutNullStreams;
			now: () => number;
		},
	) {}

	warm(helperPath: string): void {
		if (this.usable(this.standby, helperPath)) return;
		this.discard();
		const process = this.deps.spawn(helperPath);
		const standby = { process, helperPath, spawnedAt: this.deps.now() };
		process.on("error", () => undefined);
		process.once("close", () => {
			if (this.standby === standby) this.standby = null;
		});
		this.standby = standby;
		if (this.warmCamera !== null) this.sendWarmCamera();
	}

	/**
	 * Keeps the standby helper's camera running for this camera setup, or releases it with
	 * null. Call it only while the app itself shows that camera, so the camera is never
	 * held where the user cannot see it.
	 */
	setWarmCamera(camera: unknown): void {
		const changed = JSON.stringify(camera ?? null) !== JSON.stringify(this.warmCamera);
		this.warmCamera = camera ?? null;
		if (changed) this.sendWarmCamera();
	}

	private sendWarmCamera(): void {
		const standby = this.standby;
		if (!standby || !this.usable(standby, standby.helperPath)) return;
		standby.process.stdin.write(`${JSON.stringify({ warmCamera: this.warmCamera })}\n`);
	}

	/** Hands the warm helper its request, or returns null so the caller spawns a fresh one. */
	take(helperPath: string, request: unknown): ChildProcessWithoutNullStreams | null {
		const standby = this.standby;
		this.standby = null;
		if (!standby) return null;
		if (!this.usable(standby, helperPath)) {
			standby.process.kill();
			return null;
		}
		standby.process.stdin.write(`${JSON.stringify(request)}\n`);
		return standby.process;
	}

	discard(): void {
		this.standby?.process.kill();
		this.standby = null;
	}

	private usable(standby: Standby | null, helperPath: string): boolean {
		return Boolean(
			standby &&
				standby.helperPath === helperPath &&
				standby.process.exitCode === null &&
				standby.process.signalCode === null &&
				!standby.process.stdin.destroyed &&
				this.deps.now() - standby.spawnedAt < STANDBY_HELPER_MAX_AGE_MS,
		);
	}
}

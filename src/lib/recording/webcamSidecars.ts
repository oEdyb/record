import { fixWebmDuration } from "@fix-webm-duration/fix";
import type { RecorderHandle } from "@/hooks/recorderHandle";
import type { NativeMacClipWebcamInput } from "@/lib/nativeMacRecording";
import type { RecordedVideoAssetInput, RecordingSessionClip } from "@/lib/recordingSession";

export type WebcamFinalizationResult = {
	asset?: RecordedVideoAssetInput;
	error?: string;
};

type NativeMacWebcamClipEntry = {
	clipIndex: number;
	recorder: RecorderHandle;
	durationMs: number;
	webcamOffsetMs: number;
	result: Promise<WebcamFinalizationResult>;
	saved: boolean;
};

export async function finalizeWebcamAsset(
	webcamRecorder: RecorderHandle,
	fileName: string,
	durationMs: number,
	platformLabel: string,
): Promise<WebcamFinalizationResult> {
	try {
		if (webcamRecorder.recorder.state !== "inactive") {
			webcamRecorder.recorder.stop();
		}
		const webcamBlob = await webcamRecorder.recordedBlobPromise;
		if (webcamRecorder.isStreaming()) {
			return { asset: { videoData: new ArrayBuffer(0), fileName } };
		}
		if (!webcamBlob || webcamBlob.size === 0) {
			return { error: "the webcam produced no data" };
		}
		const fixedWebcamBlob = fileName.endsWith(".mp4")
			? webcamBlob
			: await fixWebmDuration(webcamBlob, durationMs);
		return { asset: { videoData: await fixedWebcamBlob.arrayBuffer(), fileName } };
	} catch (error) {
		console.error(`Failed to finalize native ${platformLabel} webcam recording:`, error);
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export async function discardWebcamRecorder(recorder: RecorderHandle): Promise<void> {
	if (recorder.recorder.state !== "inactive") {
		recorder.recorder.stop();
	}
	await recorder.recordedBlobPromise.catch(() => undefined);
	await recorder.discard().catch(() => undefined);
}

/** Stops a camera recorder that no saved clip claimed, keeping what reached its file. */
async function releaseWebcamRecorder(recorder: RecorderHandle): Promise<void> {
	if (recorder.recorder.state !== "inactive") {
		recorder.recorder.stop();
	}
	await recorder.recordedBlobPromise.catch(() => undefined);
	await recorder.release().catch((error: unknown) => {
		console.warn("Could not close the camera file:", error);
	});
}

/**
 * Owns the camera files created alongside a native clip session.
 * Every recorder ends in one state: attached to a saved clip, released with its
 * file kept, or (only when the owner discards the take) deleted.
 */
export class NativeMacWebcamClipLedger {
	private readonly entries: NativeMacWebcamClipEntry[] = [];

	queue(input: {
		clip: RecordingSessionClip;
		recorder: RecorderHandle;
		webcamOffsetMs: number;
	}): void {
		if (this.entries.some((entry) => entry.clipIndex === input.clip.index)) {
			throw new Error(`Camera clip ${input.clip.index + 1} was already finalized.`);
		}

		const durationMs = input.clip.durationMs + Math.max(0, -input.webcamOffsetMs);
		const fileName = input.recorder.fileName;
		if (!fileName) throw new Error("Camera recorder has no output filename.");
		this.entries.push({
			clipIndex: input.clip.index,
			recorder: input.recorder,
			durationMs,
			webcamOffsetMs: input.webcamOffsetMs,
			result: finalizeWebcamAsset(input.recorder, fileName, durationMs, "clip"),
			saved: false,
		});
	}

	async collectKept(keptClipIndexes: ReadonlySet<number>): Promise<{
		webcams: NativeMacClipWebcamInput[];
		failures: Array<{ clipIndex: number; error: string }>;
	}> {
		const webcams: NativeMacClipWebcamInput[] = [];
		const failures: Array<{ clipIndex: number; error: string }> = [];

		for (const entry of this.entries) {
			if (!keptClipIndexes.has(entry.clipIndex)) continue;
			const finalized = await entry.result;
			if (finalized.asset) {
				webcams.push({
					clipIndex: entry.clipIndex,
					webcam: finalized.asset,
					durationMs: entry.durationMs,
					webcamOffsetMs: entry.webcamOffsetMs,
				});
			} else if (finalized.error) {
				failures.push({ clipIndex: entry.clipIndex, error: finalized.error });
			}
		}

		return { webcams, failures };
	}

	markSaved(webcams: readonly NativeMacClipWebcamInput[]): void {
		const savedIndexes = new Set(webcams.map((webcam) => webcam.clipIndex));
		for (const entry of this.entries) {
			if (savedIndexes.has(entry.clipIndex)) entry.saved = true;
		}
	}

	private unclaimed(extraRecorders: readonly RecorderHandle[]): Set<RecorderHandle> {
		return new Set([
			...this.entries.filter((entry) => !entry.saved).map((entry) => entry.recorder),
			...extraRecorders,
		]);
	}

	/** The owner threw this take away: delete its camera files too. */
	async discardUnclaimed(extraRecorders: readonly RecorderHandle[] = []): Promise<void> {
		for (const recorder of this.unclaimed(extraRecorders)) {
			await discardWebcamRecorder(recorder);
		}
	}

	/**
	 * A failed attach or Stop, a failed later write, or a removed clip leaves camera
	 * footage nothing has claimed yet. The session and recovery journal can still point
	 * at these files, so close them and never delete them.
	 */
	async releaseUnclaimed(extraRecorders: readonly RecorderHandle[] = []): Promise<void> {
		for (const recorder of this.unclaimed(extraRecorders)) {
			await releaseWebcamRecorder(recorder);
		}
	}

	clear(): void {
		this.entries.length = 0;
	}
}

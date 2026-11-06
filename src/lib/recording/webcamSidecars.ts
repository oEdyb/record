import { fixWebmDuration } from "@fix-webm-duration/fix";
import type { RecorderHandle } from "@/hooks/recorderHandle";
import type { NativeMacClipWebcamInput } from "@/lib/nativeMacRecording";
import type { RecordedVideoAssetInput, RecordingSessionClip } from "@/lib/recordingSession";

export type WebcamFinalizationResult =
	| { asset: RecordedVideoAssetInput; error?: never }
	| { asset?: never; error: string };

type ClipContext = { clipIndex: number; durationMs: number; webcamOffsetMs: number };
type WebcamContext = {
	recorder: RecorderHandle;
	token: symbol;
	take: symbol;
	clip: ClipContext | null;
};
type Ownership =
	| { kind: "unclaimed" | "attached" | "attached-unclosed" | "released" | "discarded" }
	| { kind: "releasing" | "releasing-attached" | "discarding"; job: Promise<void> };
type Finalization =
	| { kind: "untracked" }
	| { kind: "pending"; result: Promise<WebcamFinalizationResult> }
	| { kind: "settled"; result: WebcamFinalizationResult };
type Entry = { context: WebcamContext; ownership: Ownership; finalization: Finalization };
type LedgerEvent =
	| { type: "queue"; context: WebcamContext; result: Promise<WebcamFinalizationResult> }
	| { type: "extra"; context: WebcamContext }
	| { type: "finalized"; context: WebcamContext; result: WebcamFinalizationResult }
	| { type: "attach"; context: WebcamContext }
	| {
			type: "cleanup";
			context: WebcamContext;
			intent: "release" | "discard";
			schedule: () => Promise<void>;
	  }
	| { type: "cleaned"; context: WebcamContext; job: Promise<void>; outcome: "success" | "failure" }
	| { type: "clear" }
	| { type: "begin-take" };

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
	await recorder.discard();
}

/** Stops a camera recorder that no saved clip claimed, keeping what reached its file. */
async function releaseWebcamRecorder(recorder: RecorderHandle): Promise<void> {
	if (recorder.recorder.state !== "inactive") {
		recorder.recorder.stop();
	}
	await recorder.recordedBlobPromise.catch(() => undefined);
	await recorder.release().catch((error: unknown) => {
		console.warn("Could not close the camera file:", error);
		throw error;
	});
}

/**
 * Owns the camera files created alongside a native clip session.
 * Every recorder ends in one state: attached to a saved clip, released with its
 * file kept, or (only when the owner discards the take) deleted.
 */
export class NativeMacWebcamClipLedger {
	private value = { take: Symbol("camera-take"), entries: new Map<RecorderHandle, Entry>() };
	private transition(event: LedgerEvent): boolean {
		if (event.type === "clear") {
			if (
				[...this.value.entries.values()].some(
					(entry) => !["attached", "released", "discarded"].includes(entry.ownership.kind),
				)
			)
				return this.reject(event.type);
			this.value = { ...this.value, entries: new Map() };
			return true;
		}
		if (event.type === "begin-take") {
			if (
				[...this.value.entries.values()].some(
					(entry) => entry.context.recorder.recorder.state !== "inactive",
				)
			)
				return this.reject(event.type);
			this.value = { ...this.value, take: Symbol("camera-take") };
			return true;
		}
		const current = this.value.entries.get(event.context.recorder);
		if (event.type === "queue" || event.type === "extra") {
			if (
				current ||
				(event.context.clip &&
					[...this.value.entries.values()].some(
						(entry) =>
							entry.context.take === this.value.take &&
							entry.context.clip?.clipIndex === event.context.clip?.clipIndex,
					))
			)
				return this.reject(event.type);
			this.value.entries.set(event.context.recorder, {
				context: event.context,
				ownership: { kind: "unclaimed" },
				finalization:
					event.type === "queue"
						? { kind: "pending", result: event.result }
						: { kind: "untracked" },
			});
			return true;
		}
		if (!current || current.context.token !== event.context.token) return this.reject(event.type);
		switch (event.type) {
			case "finalized":
				if (current.finalization.kind !== "pending") return this.reject(event.type);
				this.value.entries.set(event.context.recorder, {
					...current,
					finalization: { kind: "settled", result: event.result },
				});
				return true;
			case "attach":
				if (current.ownership.kind === "attached-unclosed") return true;
				if (
					!["unclaimed", "released", "releasing", "attached-unclosed"].includes(
						current.ownership.kind,
					) ||
					current.finalization.kind !== "settled" ||
					!current.finalization.result.asset
				)
					return this.reject(event.type);
				this.value.entries.set(event.context.recorder, {
					...current,
					ownership:
						current.ownership.kind === "releasing"
							? { kind: "releasing-attached", job: current.ownership.job }
							: { kind: "attached" },
				});
				return true;
			case "cleanup":
				if (
					current.ownership.kind !== "unclaimed" &&
					!(current.ownership.kind === "attached-unclosed" && event.intent === "release") &&
					!(current.ownership.kind === "released" && event.intent === "discard")
				)
					return this.reject(event.type);
				this.value.entries.set(event.context.recorder, {
					...current,
					ownership: {
						kind: event.intent === "release" ? "releasing" : "discarding",
						job: event.schedule(),
					},
				});
				return true;
			case "cleaned": {
				const ownership = current.ownership;
				if (
					(ownership.kind !== "releasing" &&
						ownership.kind !== "releasing-attached" &&
						ownership.kind !== "discarding") ||
					ownership.job !== event.job
				)
					return this.reject(event.type);
				this.value.entries.set(event.context.recorder, {
					...current,
					ownership: {
						kind:
							event.outcome === "failure"
								? ownership.kind === "releasing-attached"
									? "attached-unclosed"
									: "unclaimed"
								: ownership.kind === "releasing-attached"
									? "attached"
									: ownership.kind === "releasing"
										? "released"
										: "discarded",
					},
				});
				return true;
			}
		}
	}
	private reject(event: LedgerEvent["type"]) {
		console.warn("[camera-ledger] Illegal transition", { event });
		return false;
	}
	queue(input: {
		clip: RecordingSessionClip;
		recorder: RecorderHandle;
		webcamOffsetMs: number;
	}): void {
		if (
			[...this.value.entries.values()].some(
				(entry) =>
					entry.context.take === this.value.take &&
					entry.context.clip?.clipIndex === input.clip.index,
			) ||
			this.value.entries.has(input.recorder)
		) {
			this.reject("queue");
			throw new Error(`Camera clip ${input.clip.index + 1} was already finalized.`);
		}
		const fileName = input.recorder.fileName;
		if (!fileName) throw new Error("Camera recorder has no output filename.");
		const context: WebcamContext = {
			recorder: input.recorder,
			token: Symbol("camera"),
			take: this.value.take,
			clip: {
				clipIndex: input.clip.index,
				durationMs: input.clip.durationMs + Math.max(0, -input.webcamOffsetMs),
				webcamOffsetMs: input.webcamOffsetMs,
			},
		};
		const result = finalizeWebcamAsset(
			input.recorder,
			fileName,
			context.clip?.durationMs ?? 0,
			"clip",
		);
		this.transition({ type: "queue", context, result });
		void result.then((result) => {
			this.transition({ type: "finalized", context, result });
		});
	}
	async collectKept(keptClipIndexes: ReadonlySet<number>): Promise<{
		webcams: NativeMacClipWebcamInput[];
		failures: Array<{ clipIndex: number; error: string }>;
	}> {
		const webcams: NativeMacClipWebcamInput[] = [];
		const failures: Array<{ clipIndex: number; error: string }> = [];
		for (const entry of this.value.entries.values()) {
			const clip = entry.context.clip;
			if (entry.context.take !== this.value.take || !clip || !keptClipIndexes.has(clip.clipIndex))
				continue;
			if (entry.finalization.kind === "pending") await entry.finalization.result;
			const current = this.value.entries.get(entry.context.recorder);
			if (
				!current ||
				current.context.token !== entry.context.token ||
				current.finalization.kind !== "settled"
			)
				continue;
			if (
				![
					"unclaimed",
					"attached",
					"released",
					"releasing",
					"releasing-attached",
					"attached-unclosed",
				].includes(current.ownership.kind)
			) {
				this.reject("attach");
				continue;
			}
			const finalized = current.finalization.result;
			if (finalized.asset) webcams.push({ ...clip, webcam: finalized.asset });
			else if (finalized.error)
				failures.push({ clipIndex: clip.clipIndex, error: finalized.error });
		}
		return { webcams, failures };
	}
	markSaved(webcams: readonly NativeMacClipWebcamInput[]): void {
		for (const webcam of webcams) {
			const entry = [...this.value.entries.values()].find(
				(entry) =>
					entry.context.take === this.value.take &&
					entry.context.clip?.clipIndex === webcam.clipIndex,
			);
			if (!entry || entry.context.recorder.fileName !== webcam.webcam.fileName) {
				this.reject("attach");
				continue;
			}
			if (entry.ownership.kind !== "attached" && entry.ownership.kind !== "releasing-attached")
				this.transition({ type: "attach", context: entry.context });
		}
	}
	private async cleanup(intent: "release" | "discard", extraRecorders: readonly RecorderHandle[]) {
		for (const recorder of extraRecorders) {
			if (this.value.entries.get(recorder)?.ownership.kind === "attached") this.reject("cleanup");
			else if (!this.value.entries.has(recorder))
				this.transition({
					type: "extra",
					context: { recorder, token: Symbol("extra-camera"), take: this.value.take, clip: null },
				});
		}
		const failures: unknown[] = [];
		for (const entry of this.value.entries.values()) {
			try {
				await this.cleanupEntry(intent, entry);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			console.warn("[camera-ledger] Multiple camera cleanup failures", failures);
			throw failures[0];
		}
	}
	private async cleanupEntry(intent: "release" | "discard", entry: Entry) {
		const ownership = entry.ownership;
		const cleanupIntent =
			entry.context.take !== this.value.take || ownership.kind === "attached-unclosed"
				? "release"
				: intent;
		if (
			ownership.kind === "attached" ||
			ownership.kind === "discarded" ||
			(ownership.kind === "released" && cleanupIntent === "release")
		)
			return;
		if (
			ownership.kind === "releasing" ||
			ownership.kind === "releasing-attached" ||
			ownership.kind === "discarding"
		) {
			if ((ownership.kind === "discarding") !== (cleanupIntent === "discard")) {
				this.reject("cleanup");
				throw new Error("A conflicting camera cleanup is already running.");
			}
			await ownership.job;
			return;
		}
		const context = entry.context;
		if (
			!this.transition({
				type: "cleanup",
				context,
				intent: cleanupIntent,
				schedule: () =>
					Promise.resolve().then(async () => {
						if (cleanupIntent === "release") await releaseWebcamRecorder(context.recorder);
						else await discardWebcamRecorder(context.recorder);
						if (entry.finalization.kind === "pending") await entry.finalization.result;
					}),
			})
		)
			return;
		const pending = this.value.entries.get(context.recorder)?.ownership;
		if (
			!pending ||
			(pending.kind !== "releasing" &&
				pending.kind !== "releasing-attached" &&
				pending.kind !== "discarding")
		)
			throw new Error("Camera cleanup did not retain its owner.");
		try {
			await pending.job;
			this.transition({ type: "cleaned", context, job: pending.job, outcome: "success" });
		} catch (error) {
			this.transition({ type: "cleaned", context, job: pending.job, outcome: "failure" });
			throw error;
		}
	}

	async discardUnclaimed(extraRecorders: readonly RecorderHandle[] = []): Promise<void> {
		await this.cleanup("discard", extraRecorders);
	}
	async releaseUnclaimed(extraRecorders: readonly RecorderHandle[] = []): Promise<void> {
		await this.cleanup("release", extraRecorders);
	}
	beginTake(): boolean {
		return this.transition({ type: "begin-take" });
	}
	clear(): boolean {
		return this.transition({ type: "clear" });
	}
}

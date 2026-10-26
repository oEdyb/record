import { randomUUID } from "node:crypto";
import type { NativeRecordingAppStopRequest } from "../../src/lib/nativeMacRecording";

type RecordingRenderer = {
	isDestroyed: () => boolean;
	send: (channel: string, request: NativeRecordingAppStopRequest) => void;
	once: (event: "destroyed", listener: () => void) => unknown;
	removeListener: (event: "destroyed", listener: () => void) => unknown;
};

/** Only the renderer that started this take may confirm its durable source handoff. */
export class RendererRecordingStop {
	private take: {
		owner: RecordingRenderer;
		request: NativeRecordingAppStopRequest;
		completed: boolean;
		error?: Error;
	} | null = null;
	private pending: {
		owner: RecordingRenderer;
		request: NativeRecordingAppStopRequest;
		finish: (error?: Error) => void;
	} | null = null;

	bind(owner: RecordingRenderer, recordingId: number): NativeRecordingAppStopRequest {
		this.pending?.finish(new Error("Another recording replaced the pending renderer handoff."));
		this.take = { owner, request: { recordingId, token: randomUUID() }, completed: false };
		return this.take.request;
	}

	pendingRecordingId(): number | null {
		return this.take && !this.take.completed ? this.take.request.recordingId : null;
	}

	owns(sender: unknown, recordingId: number, token: string): boolean {
		return Boolean(
			this.take &&
				!this.take.completed &&
				!this.take.owner.isDestroyed() &&
				this.take.owner === sender &&
				this.take.request.recordingId === recordingId &&
				this.take.request.token === token,
		);
	}

	wait(recordingId: number, signal: AbortSignal): Promise<void> {
		const take = this.take;
		if (take?.completed && take.request.recordingId === recordingId)
			return take.error ? Promise.reject(take.error) : Promise.resolve();
		if (!take || take.request.recordingId !== recordingId || take.owner.isDestroyed())
			return Promise.reject(new Error("The recording HUD closed before its camera handoff."));
		if (signal.aborted)
			return Promise.reject(new Error("Renderer camera handoff deadline expired."));
		return new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				if (this.pending?.finish !== finish) return;
				if (error && !take.completed) {
					take.completed = true;
					take.error = error;
				}
				this.pending = null;
				take.owner.removeListener("destroyed", onClosed);
				signal.removeEventListener("abort", onAborted);
				if (error) reject(error);
				else resolve();
			};
			const onClosed = () =>
				finish(new Error("The recording HUD closed before its camera handoff."));
			const onAborted = () => finish(new Error("Renderer camera handoff deadline expired."));
			this.pending = { ...take, finish };
			take.owner.once("destroyed", onClosed);
			signal.addEventListener("abort", onAborted, { once: true });
			try {
				take.owner.send("native-mac-recording-stopped-by-app", take.request);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	acknowledge(sender: RecordingRenderer, value: unknown): boolean {
		const take = this.take;
		if (!take || take.completed || sender !== take.owner || !value || typeof value !== "object")
			return false;
		if (!("recordingId" in value && "token" in value && "success" in value)) return false;
		if (
			value.recordingId !== take.request.recordingId ||
			value.token !== take.request.token ||
			typeof value.success !== "boolean"
		)
			return false;
		const message =
			"error" in value && typeof value.error === "string"
				? value.error.slice(0, 2000)
				: "The recording HUD could not save every camera source.";
		take.completed = true;
		take.error = value.success ? undefined : new Error(message);
		if (take.error && !this.pending)
			console.warn("[capture] Renderer source handoff failed:", take.error);
		this.pending?.finish(take.error);
		return true;
	}
}

import { randomUUID } from "node:crypto";
import type { NativeRecordingAppStopRequest } from "../../src/lib/nativeMacRecording";

type RecordingRenderer = {
	isDestroyed(): boolean;
	send(channel: string, request: NativeRecordingAppStopRequest): void;
	once(event: "destroyed", listener: () => void): unknown;
	removeListener(event: "destroyed", listener: () => void): unknown;
};
type Take = { owner: RecordingRenderer; request: NativeRecordingAppStopRequest };
type Pending = { promise: Promise<void>; finish(error?: Error): void };
type HandoffState =
	| { kind: "unbound" }
	| { kind: "bound"; take: Take }
	| { kind: "waiting"; take: Take; pending: Pending }
	| { kind: "acknowledged"; take: Take }
	| { kind: "failed"; take: Take; error: Error };
type Event =
	| { type: "bind"; take: Take }
	| { type: "wait"; request: NativeRecordingAppStopRequest; pending: Pending }
	| { type: "fail"; request: NativeRecordingAppStopRequest; error: Error }
	| { type: "acknowledge"; sender: RecordingRenderer; value: unknown };

export class RendererRecordingStop {
	private state: HandoffState = { kind: "unbound" };
	bind(owner: RecordingRenderer, recordingId: number): NativeRecordingAppStopRequest {
		const request = { recordingId, token: randomUUID() };
		this.transition({ type: "bind", take: { owner, request } });
		return request;
	}
	pendingRecordingId(): number | null {
		const s = this.state;
		return s.kind === "bound" || s.kind === "waiting" ? s.take.request.recordingId : null;
	}
	owns(sender: unknown, recordingId: number, token: string): boolean {
		const s = this.state;
		return (
			(s.kind === "bound" || s.kind === "waiting") &&
			!s.take.owner.isDestroyed() &&
			s.take.owner === sender &&
			s.take.request.recordingId === recordingId &&
			s.take.request.token === token
		);
	}
	wait(recordingId: number, signal: AbortSignal): Promise<void> {
		const s = this.state;
		if (s.kind !== "unbound" && s.take.request.recordingId === recordingId) {
			if (s.kind === "acknowledged") return Promise.resolve();
			if (s.kind === "failed") return Promise.reject(s.error);
			if (s.kind === "waiting") return s.pending.promise;
		}
		if (
			s.kind === "unbound" ||
			s.take.request.recordingId !== recordingId ||
			s.take.owner.isDestroyed()
		)
			return Promise.reject(new Error("The recording HUD closed before its camera handoff."));
		if (signal.aborted)
			return Promise.reject(new Error("Renderer camera handoff deadline expired."));
		if (s.kind !== "bound")
			return Promise.reject(new Error("The recording camera handoff is already settled."));
		const take = s.take;
		const onClosed = () =>
			this.transition({
				type: "fail",
				request: take.request,
				error: new Error("The recording HUD closed before its camera handoff."),
			});
		const onAborted = () =>
			this.transition({
				type: "fail",
				request: take.request,
				error: new Error("Renderer camera handoff deadline expired."),
			});
		let finish: (error?: Error) => void = () => undefined;
		const promise = new Promise<void>((resolve, reject) => {
			finish = (error) => {
				take.owner.removeListener("destroyed", onClosed);
				signal.removeEventListener("abort", onAborted);
				if (error) reject(error);
				else resolve();
			};
		});
		if (!this.transition({ type: "wait", request: take.request, pending: { promise, finish } }))
			return Promise.reject(new Error("The recording camera handoff changed."));
		try {
			take.owner.once("destroyed", onClosed);
			signal.addEventListener("abort", onAborted, { once: true });
			take.owner.send("native-mac-recording-stopped-by-app", take.request);
		} catch (error) {
			this.transition({
				type: "fail",
				request: take.request,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
		return promise;
	}
	abandon(): void {
		const s = this.state;
		if (s.kind !== "bound" && s.kind !== "waiting") return;
		this.transition({
			type: "fail",
			request: s.take.request,
			error: new Error("The recording HUD crashed before its camera handoff."),
		});
	}
	acknowledge(sender: RecordingRenderer, value: unknown): boolean {
		return this.transition({ type: "acknowledge", sender, value });
	}
	private transition(event: Event): boolean {
		const s = this.state;
		const reject = () => {
			console.warn("[renderer-recording-stop] Illegal transition", {
				state: s.kind,
				event: event.type,
				recordingId: s.kind === "unbound" ? null : s.take.request.recordingId,
			});
			return false;
		};
		if (event.type === "bind") {
			this.state = { kind: "bound", take: event.take };
			if (s.kind === "waiting")
				s.pending.finish(new Error("Another recording replaced the pending renderer handoff."));
			return true;
		}
		if (s.kind !== "bound" && s.kind !== "waiting") return reject();
		if (event.type === "wait") {
			if (s.kind !== "bound" || event.request !== s.take.request) return reject();
			this.state = { kind: "waiting", take: s.take, pending: event.pending };
			return true;
		}
		if (event.type === "fail") {
			if (event.request !== s.take.request) return reject();
			this.state = { kind: "failed", take: s.take, error: event.error };
			if (s.kind === "waiting") s.pending.finish(event.error);
			return true;
		}
		const value = event.value;
		if (
			event.sender !== s.take.owner ||
			!value ||
			typeof value !== "object" ||
			!("recordingId" in value && "token" in value && "success" in value) ||
			value.recordingId !== s.take.request.recordingId ||
			value.token !== s.take.request.token ||
			typeof value.success !== "boolean"
		)
			return reject();
		if (value.success) {
			this.state = { kind: "acknowledged", take: s.take };
			if (s.kind === "waiting") s.pending.finish();
		} else {
			const message =
				"error" in value && typeof value.error === "string"
					? value.error.slice(0, 2000)
					: "The recording HUD could not save every camera source.";
			const error = new Error(message);
			this.state = { kind: "failed", take: s.take, error };
			if (s.kind === "waiting") s.pending.finish(error);
			else console.warn("[capture] Renderer source handoff failed:", error);
		}
		return true;
	}
}

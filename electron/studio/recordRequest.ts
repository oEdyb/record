import { recordRequestTrace } from "./recordRequestTrace";
import type { StudioRecordResult } from "./types";

interface RecordRequestDeps {
	owner: () => object | null;
	ensure: () => void;
	send: (token: number) => void;
	take: () => { running: boolean; recordingId: number | null } | null;
}

export class RecordRequest {
	private readonly subscribers = new WeakSet<object>();
	private pending: {
		token: number;
		owner: object | null;
		stage: string;
		timer: ReturnType<typeof setTimeout>;
		resolve: (result: StudioRecordResult) => void;
	} | null = null;

	constructor(private readonly deps: RecordRequestDeps) {}

	isPending(): boolean {
		return this.pending !== null;
	}

	start(): Promise<StudioRecordResult> {
		if (this.pending || this.deps.take()?.running)
			return Promise.resolve({
				success: false,
				error: "Recording is already running or starting.",
			});
		const token = recordRequestTrace.begin({ pillPresent: this.deps.owner() !== null });
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const stage = this.pending?.stage ?? "waiting-for-renderer";
				recordRequestTrace.add(token, `timeout:${stage}`);
				this.finish({
					success: false,
					error: "Recording start was not confirmed. Check recording controls before trying again.",
				});
			}, 30000);
			timer.unref?.();
			this.pending = { token, owner: null, stage: "waiting-for-renderer", timer, resolve };
			try {
				this.deps.ensure();
				this.dispatch();
			} catch {
				this.finish({
					success: false,
					error: "The recording controls could not be opened. Reopen Klippt and try again.",
				});
			}
		});
	}

	ready(sender: object, ready: boolean) {
		if (this.pending)
			recordRequestTrace.add(this.pending.token, "subscription", {
				ready,
				ownerPresent: this.deps.owner() !== null,
				matchesOwner: sender === this.deps.owner(),
			});
		if (sender !== this.deps.owner()) return;
		if (ready) this.subscribers.add(sender);
		else this.subscribers.delete(sender);
		this.dispatch();
	}

	accepts(sender: object, token: number): boolean {
		return (
			this.pending?.token === token && this.pending.owner === sender && this.deps.owner() === sender
		);
	}

	unavailable(sender: object) {
		if (this.pending)
			recordRequestTrace.add(this.pending.token, "subscription-invalidated", {
				matchesOwner: sender === this.deps.owner(),
				wasDispatched: this.pending.owner === sender,
			});
		this.subscribers.delete(sender);
		if (this.pending?.owner === sender) {
			recordRequestTrace.add(this.pending.token, "owner-unavailable");
			this.finish({
				success: false,
				error:
					"Recording controls closed or reloaded before start was confirmed. Reopen Klippt and try again.",
			});
		}
	}

	progress(
		sender: object,
		token: number,
		stage: string,
		flags: Record<string, boolean | number | null>,
	) {
		const pending = this.pending;
		if (!pending || !this.accepts(sender, token)) return;
		pending.stage = stage;
		if (stage === "writer-started") {
			const take = this.deps.take();
			if (take?.running && take.recordingId !== null && take.recordingId === flags.recordingId)
				this.finish({ success: true, recordingId: take.recordingId });
		} else if (stage === "windows-writer-started" || stage === "browser-writer-started") {
			if (
				typeof flags.recordingId === "number" &&
				Number.isSafeInteger(flags.recordingId) &&
				flags.recordingId > 0
			)
				this.finish({ success: true, recordingId: flags.recordingId });
		} else if (
			stage === "renderer-guard" ||
			(stage === "hook-entry" &&
				(flags.pending || flags.recording || flags.sourceSelectionInFlight || flags.writerPending))
		) {
			this.finish({
				success: false,
				error:
					"The recording controls are busy. Wait for saving or starting to finish, then try again.",
			});
		} else if (
			(stage === "selector-result" && !flags.portalOwnsSelection) ||
			stage === "permission-required"
		) {
			this.finish({
				success: false,
				error:
					"Recording needs your attention. Choose a source or grant capture permission in the recording controls.",
			});
		} else if (
			stage === "prepare-failed" ||
			stage === "writer-failed" ||
			stage === "selector-rejected" ||
			(stage === "cleanup" && !flags.captureStarted)
		) {
			this.finish({
				success: false,
				error: "Recording did not start. Check the error in the recording controls and try again.",
			});
		}
	}

	private dispatch() {
		const pending = this.pending;
		const owner = this.deps.owner();
		if (!pending || pending.owner || !owner || !this.subscribers.has(owner)) return;
		pending.owner = owner;
		pending.stage = "sent";
		this.deps.send(pending.token);
	}

	private finish(result: StudioRecordResult) {
		const pending = this.pending;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending = null;
		pending.resolve(result);
	}
}

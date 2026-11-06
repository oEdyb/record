export type FinishIntent = "save" | "discard" | "restart";
type Transport = { promise: Promise<void>; resolve(): void };
type Active = { kind: "recording" | "paused"; takeId: number };
type Moving = {
	kind: "pausing" | "configuring-resume" | "resuming";
	takeId: number;
	completion: Transport;
};
export type RecorderState =
	| { kind: "idle" }
	| { kind: "restarting" }
	| { kind: "preparing"; runId: number }
	| { kind: "start-cancelling" }
	| { kind: "detached"; takeId: number }
	| { kind: "starting"; origin: "record" | "restart" }
	| Active
	| Moving
	| {
			kind: "stop-queued";
			takeId: number;
			operation: Moving["kind"];
			completion: Transport;
			intent: FinishIntent;
	  }
	| {
			kind: "stop-requested" | "stopping";
			takeId: number;
			previous: Active["kind"];
			intent: FinishIntent;
	  }
	| { kind: "saving"; takeId: number; intent: FinishIntent }
	| { kind: "selecting" | "selection-cancelling"; previous: Active | { kind: "idle" } }
	| { kind: "failed"; takeId: number };

type Event =
	| { type: "prepare"; runId: number }
	| { type: "start" }
	| { type: "started"; takeId: number }
	| { type: "cancel-start" | "start-settled" | "detach" }
	| { type: "pause" | "resume" | "resume-dispatched" }
	| { type: "paused" | "resumed"; takeId: number }
	| { type: "transport-failed"; takeId: number; paused: boolean }
	| { type: "request-stop"; intent: FinishIntent }
	| { type: "begin-stop"; takeId: number; intent: FinishIntent }
	| { type: "writer-released" | "saved" | "writer-failed"; takeId: number }
	| { type: "select" | "cancel-selection" | "selected" };

export class RecorderLifecycle {
	private state: RecorderState = { kind: "idle" };
	private readonly listeners = new Set<() => void>();
	getSnapshot = (): RecorderState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	transition(event: Event): boolean {
		const s = this.state;
		let next: RecorderState;
		switch (event.type) {
			case "prepare":
				if (s.kind !== "idle") return this.reject(event);
				next = { kind: "preparing", runId: event.runId };
				break;
			case "start":
				if (!["idle", "restarting", "preparing"].includes(s.kind)) return this.reject(event);
				next = { kind: "starting", origin: s.kind === "restarting" ? "restart" : "record" };
				break;
			case "started":
				if (s.kind !== "starting") return this.reject(event);
				next = { kind: "recording", takeId: event.takeId };
				break;
			case "cancel-start":
				if (s.kind !== "preparing" && s.kind !== "starting" && s.kind !== "start-cancelling")
					return this.reject(event);
				next = { kind: s.kind === "preparing" ? "idle" : "start-cancelling" };
				break;
			case "start-settled":
				if (s.kind !== "starting" && s.kind !== "start-cancelling") return this.reject(event);
				next = { kind: "idle" };
				break;
			case "detach":
				if (!("takeId" in s)) return this.reject(event);
				next = { kind: "detached", takeId: s.takeId };
				break;
			case "pause":
			case "resume": {
				if (s.kind !== (event.type === "pause" ? "recording" : "paused") || !("takeId" in s))
					return this.reject(event);
				let resolve: () => void = () => undefined;
				const promise = new Promise<void>((done) => {
					resolve = done;
				});
				next = {
					kind: event.type === "pause" ? "pausing" : "configuring-resume",
					takeId: s.takeId,
					completion: { promise, resolve },
				};
				break;
			}
			case "resume-dispatched":
				if (s.kind !== "configuring-resume") return this.reject(event);
				next = { ...s, kind: "resuming" };
				break;
			case "paused":
			case "resumed":
			case "transport-failed": {
				if (!("takeId" in s) || s.takeId !== event.takeId) return this.reject(event);
				const paused =
					event.type === "paused" || (event.type === "transport-failed" && event.paused);
				if (
					s.kind === "pausing" ||
					s.kind === "configuring-resume" ||
					s.kind === "resuming" ||
					s.kind === "stop-queued"
				) {
					next =
						s.kind === "stop-queued"
							? {
									kind: "stop-requested",
									takeId: s.takeId,
									previous: paused ? "paused" : "recording",
									intent: s.intent,
								}
							: { kind: paused ? "paused" : "recording", takeId: s.takeId };
					s.completion.resolve();
				} else if (s.kind === "recording" || s.kind === "paused") {
					next = { kind: paused ? "paused" : "recording", takeId: s.takeId };
				} else return this.reject(event);
				break;
			}
			case "request-stop": {
				if (s.kind === "pausing" || s.kind === "resuming") {
					next = {
						kind: "stop-queued",
						takeId: s.takeId,
						operation: s.kind,
						completion: s.completion,
						intent: event.intent,
					};
				} else if (
					s.kind === "stop-queued" ||
					s.kind === "stop-requested" ||
					s.kind === "stopping" ||
					s.kind === "saving"
				) {
					next = {
						...s,
						intent:
							s.intent === "save" || event.intent === "save"
								? "save"
								: s.intent === "restart" || event.intent === "restart"
									? "restart"
									: "discard",
					};
				} else {
					const previous =
						s.kind === "selecting" || s.kind === "selection-cancelling" ? s.previous : s;
					if (previous.kind === "configuring-resume") {
						previous.completion.resolve();
						next = {
							kind: "stop-requested",
							takeId: previous.takeId,
							previous: "paused",
							intent: event.intent,
						};
						break;
					}
					if (
						previous.kind !== "recording" &&
						previous.kind !== "paused" &&
						previous.kind !== "failed"
					)
						return this.reject(event);
					next = {
						kind: "stop-requested",
						takeId: previous.takeId,
						previous: previous.kind === "paused" ? "paused" : "recording",
						intent: event.intent,
					};
				}
				break;
			}
			case "begin-stop":
				if (s.kind === "stop-queued") return this.reject(event);
				if (
					!("takeId" in s) ||
					s.takeId !== event.takeId ||
					!["recording", "paused", "failed", "stop-requested"].includes(s.kind)
				)
					return this.reject(event);
				next = {
					kind: "stopping",
					takeId: event.takeId,
					previous:
						s.kind === "paused" ? "paused" : s.kind === "stop-requested" ? s.previous : "recording",
					intent: "intent" in s ? s.intent : event.intent,
				};
				break;
			case "writer-released":
				if ((s.kind !== "stopping" && s.kind !== "saving") || s.takeId !== event.takeId)
					return this.reject(event);
				next = { kind: "saving", takeId: s.takeId, intent: s.intent };
				break;
			case "saved":
				if ((s.kind !== "saving" && s.kind !== "stopping") || s.takeId !== event.takeId)
					return this.reject(event);
				next = { kind: s.intent === "restart" ? "restarting" : "idle" };
				break;
			case "writer-failed":
				if (!("takeId" in s) || s.takeId !== event.takeId) return this.reject(event);
				if (
					s.kind === "pausing" ||
					s.kind === "configuring-resume" ||
					s.kind === "resuming" ||
					s.kind === "stop-queued"
				)
					s.completion.resolve();
				next = { kind: "failed", takeId: event.takeId };
				break;
			case "select":
				if (s.kind !== "idle" && s.kind !== "paused") return this.reject(event);
				next = { kind: "selecting", previous: s.kind === "idle" ? { kind: "idle" } : s };
				break;
			case "cancel-selection":
				if (s.kind !== "selecting") return this.reject(event);
				next = { ...s, kind: "selection-cancelling" };
				break;
			case "selected":
				if (s.kind !== "selecting" && s.kind !== "selection-cancelling") return this.reject(event);
				next = s.previous;
				break;
		}
		this.state = next;
		for (const listener of this.listeners) listener();
		return true;
	}

	waitUntilSaved(takeId: number): Promise<void> {
		return new Promise((resolve) => {
			const check = () => {
				const state = this.state;
				if (!("takeId" in state) || state.takeId !== takeId) {
					unsubscribe();
					resolve();
				}
			};
			const unsubscribe = this.subscribe(check);
			check();
		});
	}

	transport(): Promise<void> | null {
		const s = this.state;
		return s.kind === "pausing" || s.kind === "resuming" || s.kind === "stop-queued"
			? s.completion.promise
			: null;
	}
	isPaused(takeId?: number): boolean {
		let s = this.state;
		if (s.kind === "selecting" || s.kind === "selection-cancelling") s = s.previous;
		if (takeId !== undefined && (!("takeId" in s) || s.takeId !== takeId)) return false;
		return (
			s.kind === "paused" ||
			s.kind === "configuring-resume" ||
			s.kind === "pausing" ||
			s.kind === "resuming" ||
			s.kind === "stop-queued" ||
			((s.kind === "stop-requested" || s.kind === "stopping") && s.previous === "paused")
		);
	}
	isFinalizing(takeId: number): boolean {
		const current = this.state;
		const s =
			current.kind === "selecting" || current.kind === "selection-cancelling"
				? current.previous
				: current;
		return !("takeId" in s) || s.takeId !== takeId || s.kind === "stopping" || s.kind === "saving";
	}
	intent(): FinishIntent | null {
		return "intent" in this.state ? this.state.intent : null;
	}
	get starting() {
		return this.state.kind === "starting" || this.state.kind === "start-cancelling";
	}
	get pendingStartId() {
		return this.state.kind === "preparing" ? this.state.runId : null;
	}
	get selecting() {
		return this.state.kind === "selecting" || this.state.kind === "selection-cancelling";
	}
	get selectionCancelled() {
		return this.state.kind === "selection-cancelling";
	}
	get restarting() {
		return (
			this.state.kind === "restarting" ||
			(this.state.kind === "starting" && this.state.origin === "restart") ||
			this.intent() === "restart"
		);
	}
	get finalizingId() {
		return this.state.kind === "stopping" || this.state.kind === "saving"
			? this.state.takeId
			: null;
	}
	get discardId() {
		return "takeId" in this.state && this.intent() !== null && this.intent() !== "save"
			? this.state.takeId
			: null;
	}
	get autoFinalize() {
		return "takeId" in this.state && this.state.kind !== "detached";
	}
	private reject(event: Event): false {
		console.warn("[recorder-lifecycle] Illegal transition", {
			state: this.state.kind,
			event: event.type,
		});
		return false;
	}
}

export function recorderPresentation(s: RecorderState) {
	const base = s.kind === "selecting" || s.kind === "selection-cancelling" ? s.previous : s;
	return {
		recording: [
			"recording",
			"paused",
			"pausing",
			"configuring-resume",
			"resuming",
			"stop-queued",
			"stop-requested",
			"stopping",
		].includes(base.kind),
		paused:
			["paused", "pausing", "configuring-resume", "resuming", "stop-queued"].includes(base.kind) ||
			((base.kind === "stop-requested" || base.kind === "stopping") && base.previous === "paused"),
		saving: (base.kind === "stopping" || base.kind === "saving") && base.intent === "save",
		countdownActive: s.kind === "preparing" || s.kind === "starting",
		clipFinalizing:
			s.kind === "pausing" ||
			s.kind === "configuring-resume" ||
			s.kind === "resuming" ||
			s.kind === "stop-queued",
		sourceSelecting: s.kind === "selecting" || s.kind === "selection-cancelling",
	};
}

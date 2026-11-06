import type { ExportTransactionError, ExportTransactionPhase } from "./atomicExport";

type Capacity =
	| { kind: "idle" }
	| { kind: "checking"; task: Promise<void> }
	| { kind: "failed"; error: ExportTransactionError };
type State<T> =
	| { kind: "preflight" }
	| { kind: "rendering"; timer: ReturnType<typeof setInterval>; capacity: Capacity }
	| { kind: "capacity-draining"; capacity: Capacity }
	| { kind: "verification" | "syncing" | "publishing" | "cleanup" | "cleanup-blocked" | "failed" }
	| { kind: "committed" | "done"; result: T };
type Event<T> =
	| { type: "render"; timer: ReturnType<typeof setInterval> }
	| { type: "check"; task: Promise<void> }
	| { type: "checked"; task: Promise<void> }
	| { type: "capacity-failed"; error: ExportTransactionError }
	| { type: "rendered" }
	| { type: "phase"; phase: ExportTransactionPhase }
	| { type: "committed"; result: T }
	| { type: "done" | "cleanup-blocked" | "failed" };

export class PublicationLifecycle<T> {
	private state: State<T> = { kind: "preflight" };
	getSnapshot() {
		return this.state;
	}
	get capacityTask() {
		const s = this.state;
		return (s.kind === "rendering" || s.kind === "capacity-draining") &&
			s.capacity.kind === "checking"
			? s.capacity.task
			: null;
	}
	get capacityFailure() {
		const s = this.state;
		return (s.kind === "rendering" || s.kind === "capacity-draining") &&
			s.capacity.kind === "failed"
			? s.capacity.error
			: null;
	}
	get canCheck() {
		return this.state.kind === "rendering" && this.state.capacity.kind === "idle";
	}
	get monitoring() {
		return this.state.kind === "rendering" || this.state.kind === "capacity-draining";
	}
	get committed() {
		const s = this.state;
		return s.kind === "committed" || s.kind === "done" ? { result: s.result } : null;
	}
	transition(event: Event<T>): boolean {
		const s = this.state;
		let next: State<T>;
		const reject = () => {
			console.warn("[export-publication] Illegal transition", {
				state: s.kind,
				event: event.type,
				...(event.type === "phase" ? { phase: event.phase } : {}),
			});
			return false;
		};
		switch (event.type) {
			case "render":
				if (s.kind !== "preflight") return reject();
				next = { kind: "rendering", timer: event.timer, capacity: { kind: "idle" } };
				break;
			case "check":
				if (s.kind !== "rendering" || s.capacity.kind !== "idle") return reject();
				next = { ...s, capacity: { kind: "checking", task: event.task } };
				break;
			case "checked":
				if (s.kind !== "rendering" && s.kind !== "capacity-draining") return reject();
				if (s.capacity.kind === "failed") return true;
				if (s.capacity.kind !== "checking" || s.capacity.task !== event.task) return reject();
				next = { ...s, capacity: { kind: "idle" } };
				break;
			case "capacity-failed":
				if (!this.monitoring) return reject();
				if (s.kind !== "rendering" && s.kind !== "capacity-draining") return reject();
				next = { ...s, capacity: { kind: "failed", error: event.error } };
				break;
			case "rendered":
				if (s.kind !== "rendering") return reject();
				clearInterval(s.timer);
				next = { kind: "capacity-draining", capacity: s.capacity };
				break;
			case "phase":
				if (event.phase === "cleanup") {
					if (s.kind === "committed" || s.kind === "done") return reject();
					if (s.kind === "rendering") clearInterval(s.timer);
					next = { kind: "cleanup" };
					break;
				}
				if (
					(event.phase === "preflight" && s.kind === "preflight") ||
					(event.phase === "rendering" && s.kind === "rendering")
				)
					return true;
				if (
					(event.phase === "verification" &&
						s.kind === "capacity-draining" &&
						s.capacity.kind === "idle") ||
					(event.phase === "syncing" && s.kind === "verification") ||
					(event.phase === "publishing" && s.kind === "syncing")
				)
					next = { kind: event.phase };
				else return reject();
				break;
			case "committed":
				if (s.kind !== "publishing") return reject();
				next = { kind: "committed", result: event.result };
				break;
			case "done":
				if (s.kind !== "committed") return reject();
				next = { ...s, kind: "done" };
				break;
			case "cleanup-blocked":
			case "failed":
				if (s.kind !== "cleanup") return reject();
				next = { kind: event.type };
				break;
		}
		this.state = next;
		return true;
	}
}

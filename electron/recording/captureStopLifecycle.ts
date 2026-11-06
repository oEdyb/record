type StopState = { kind: "waiting" } | { kind: "terminating" } | { kind: "settled" };
type StopEvent<T> = { type: "terminate" } | { type: "complete" | "terminated"; result: T };

export class CaptureStopLifecycle<T> {
	private state: StopState = { kind: "waiting" };
	constructor(
		private readonly operation: string,
		private readonly settle: (result: T) => void,
	) {}
	transition(event: StopEvent<T>): boolean {
		const state = this.state;
		const expected = event.type === "terminated" ? "terminating" : "waiting";
		if (state.kind !== expected) {
			console.warn("[capture-stop-lifecycle] Illegal transition", {
				operation: this.operation,
				state: state.kind,
				event: event.type,
			});
			return false;
		}
		if (event.type === "terminate") this.state = { kind: "terminating" };
		else {
			this.state = { kind: "settled" };
			this.settle(event.result);
		}
		return true;
	}
}

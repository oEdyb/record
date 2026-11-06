import type { RecordingSessionClip } from "../../src/lib/recordingSession";

type Clips = RecordingSessionClip[];
type Change = { token: symbol; clips: Clips };
type State = { clips: Clips } & (
	| { kind: "ready" }
	| { kind: "changing"; change: Change }
	| { kind: "needs-recovery"; change: Change; timer: ReturnType<typeof setTimeout> | null }
	| { kind: "reconciling"; change: Change }
);
type Event =
	| { type: "reset" }
	| { type: "clips"; clips: Clips }
	| { type: "begin"; change: Change }
	| { type: "committed"; token: symbol }
	| { type: "failed"; token: symbol }
	| { type: "retry"; schedule: () => ReturnType<typeof setTimeout> }
	| { type: "reconcile" }
	| { type: "reconciled"; token: symbol }
	| { type: "cancel-retry" };

export class ClipJournalLifecycle {
	private value: State = { kind: "ready", clips: [] };
	get clips() {
		return this.value.clips;
	}
	get state(): Readonly<State> {
		return this.value;
	}
	get editsPaused() {
		return this.value.kind === "needs-recovery" || this.value.kind === "reconciling";
	}
	transition(event: Event): boolean {
		const state = this.value;
		switch (event.type) {
			case "reset":
				if (state.kind === "needs-recovery" && state.timer) clearTimeout(state.timer);
				this.value = { kind: "ready", clips: [] };
				return true;
			case "clips":
				this.value = { ...state, clips: event.clips };
				return true;
			case "begin":
				if (state.kind !== "ready") break;
				this.value = { ...state, kind: "changing", change: event.change };
				return true;
			case "committed":
				if (state.kind !== "changing" || state.change.token !== event.token) break;
				this.value = { kind: "ready", clips: state.change.clips };
				return true;
			case "failed":
				if (
					(state.kind !== "changing" && state.kind !== "reconciling") ||
					state.change.token !== event.token
				)
					break;
				this.value = { ...state, kind: "needs-recovery", timer: null };
				return true;
			case "retry":
				if (state.kind !== "needs-recovery" || state.timer) break;
				this.value = { ...state, timer: event.schedule() };
				return true;
			case "reconcile":
				if (state.kind !== "needs-recovery") break;
				if (state.timer) clearTimeout(state.timer);
				this.value = { kind: "reconciling", change: state.change, clips: state.clips };
				return true;
			case "reconciled":
				if (state.kind !== "reconciling" || state.change.token !== event.token) break;
				this.value = { kind: "ready", clips: state.clips };
				return true;
			case "cancel-retry":
				if (state.kind === "needs-recovery" && state.timer) {
					clearTimeout(state.timer);
					this.value = { ...state, timer: null };
				}
				return true;
		}
		console.warn("[clip-journal] Illegal transition", { state: state.kind, event: event.type });
		return false;
	}
}

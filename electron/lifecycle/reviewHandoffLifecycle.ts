type State<W> =
	| { kind: "idle"; sequence: number }
	| { kind: "awaiting-window"; token: number; ready: () => void }
	| {
			kind: "awaiting-renderer";
			token: number;
			ready: () => void;
			window: W;
			timer: ReturnType<typeof setTimeout> | null;
	  };
type Event<W> =
	| { type: "begin"; ready: () => void }
	| { type: "bind"; window: W }
	| { type: "deadline"; token: number; schedule: () => ReturnType<typeof setTimeout> }
	| { type: "reveal"; token: number }
	| { type: "cancel" };
export class ReviewHandoffLifecycle<W> {
	private value: State<W> = { kind: "idle", sequence: 0 };
	get pending() {
		const state = this.value;
		return state.kind === "idle"
			? null
			: {
					token: state.token,
					ready: state.ready,
					window: state.kind === "awaiting-renderer" ? state.window : null,
				};
	}
	transition(event: Event<W>): boolean {
		const state = this.value;
		switch (event.type) {
			case "begin":
				if (state.kind !== "idle") break;
				this.value = { kind: "awaiting-window", token: state.sequence + 1, ready: event.ready };
				return true;
			case "bind":
				if (state.kind === "idle") break;
				this.value = {
					...state,
					kind: "awaiting-renderer",
					window: event.window,
					timer: state.kind === "awaiting-renderer" ? state.timer : null,
				};
				return true;
			case "deadline":
				if (state.kind !== "awaiting-renderer" || state.token !== event.token || state.timer) break;
				this.value = { ...state, timer: event.schedule() };
				return true;
			case "reveal":
				if (state.kind !== "awaiting-renderer" || state.token !== event.token) break;
				if (state.timer) clearTimeout(state.timer);
				this.value = { kind: "idle", sequence: state.token };
				return true;
			case "cancel":
				if (state.kind === "idle") return true;
				if (state.kind === "awaiting-renderer" && state.timer) clearTimeout(state.timer);
				this.value = { kind: "idle", sequence: state.token };
				return true;
		}
		console.warn("[review-handoff] Illegal transition", { state: state.kind, event: event.type });
		return false;
	}
}

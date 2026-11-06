type State =
	| { kind: "clean" | "dirty" | "confirming" | "saving" }
	| { kind: "forcing"; previous: State };
type Event<W> = { window: W } & (
	| { type: "dirty"; dirty: boolean }
	| { type: "confirm" }
	| { type: "choice"; choice: "save" | "discard" | "cancel" }
	| { type: "force" }
	| { type: "force-returned" }
	| { type: "save-finished"; shouldClose: boolean }
	| { type: "closed" }
);
export class EditorCloseLifecycle<W extends object> {
	private value = new WeakMap<W, State>();
	state(window: W) {
		return this.value.get(window) ?? ({ kind: "clean" } as const);
	}
	transition(event: Event<W>): boolean {
		const state = this.state(event.window);
		let next: State;
		switch (event.type) {
			case "closed":
				this.value.delete(event.window);
				return true;
			case "dirty":
				if (state.kind === "forcing" || state.kind === "confirming" || state.kind === "saving")
					return true;
				next = { kind: event.dirty ? "dirty" : "clean" };
				break;
			case "confirm":
				if (state.kind !== "dirty") return this.reject(event, state);
				next = { kind: "confirming" };
				break;
			case "choice":
				if (state.kind !== "confirming") return this.reject(event, state);
				next = { kind: event.choice === "save" ? "saving" : "dirty" };
				break;
			case "save-finished":
				if (state.kind !== "saving") return this.reject(event, state);
				next = { kind: event.shouldClose ? "clean" : "dirty" };
				break;
			case "force":
				next = { kind: "forcing", previous: state };
				break;
			case "force-returned":
				if (state.kind !== "forcing") return this.reject(event, state);
				next = state.previous;
				break;
		}
		this.value.set(event.window, next);
		return true;
	}
	private reject(event: Event<W>, state: State) {
		console.warn("[editor-close] Illegal transition", { state: state.kind, event: event.type });
		return false;
	}
}

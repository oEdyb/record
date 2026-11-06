type State<W> =
	| { kind: "healthy" }
	| { kind: "saving"; window: W; job: Promise<void> }
	| { kind: "saved" | "failed"; window: W };
type Event<W> =
	| { type: "recover"; window: W; schedule: () => Promise<void> }
	| { type: "finished"; window: W; saved: boolean };
export class RendererRecoveryLifecycle<W extends object> {
	private value = new WeakMap<W, State<W>>();
	transition(event: Event<W>): boolean {
		const state = this.value.get(event.window) ?? { kind: "healthy" };
		if (event.type === "recover") {
			if (state.kind !== "healthy" && state.window === event.window) return this.reject(event);
			this.value.set(event.window, { kind: "saving", window: event.window, job: event.schedule() });
			return true;
		}
		if (state.kind !== "saving" || state.window !== event.window) return this.reject(event);
		this.value.set(event.window, { kind: event.saved ? "saved" : "failed", window: event.window });
		return true;
	}
	private reject(event: Event<W>) {
		console.warn("[renderer-recovery] Illegal transition", {
			state: this.value.get(event.window)?.kind ?? "healthy",
			event: event.type,
		});
		return false;
	}
}

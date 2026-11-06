import type { StudioCommand } from "../../../electron/studio/types";

export type StudioCommandState =
	| { kind: "idle" }
	| { kind: "pending"; command: StudioCommand; token: symbol };

type Event =
	| { type: "send"; command: StudioCommand; token: symbol }
	| { type: "settle"; token: symbol }
	| { type: "snapshot" };

export class StudioCommandStateStore {
	private state: StudioCommandState = { kind: "idle" };
	private readonly listeners = new Set<() => void>();

	getSnapshot = (): StudioCommandState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	transition(event: Event): boolean {
		const current = this.state;
		if (event.type === "send") {
			if (current.kind !== "idle") return this.reject(event);
			this.state = { kind: "pending", command: event.command, token: event.token };
		} else if (event.type === "settle") {
			if (current.kind !== "pending" || current.token !== event.token) return this.reject(event);
			this.state = { kind: "idle" };
		} else {
			if (current.kind === "idle") return true;
			this.state = { kind: "idle" };
		}
		for (const listener of this.listeners) listener();
		return true;
	}

	private reject(event: Event): false {
		console.warn("[studio-command] Illegal transition", {
			state: this.state.kind,
			event: event.type,
		});
		return false;
	}
}

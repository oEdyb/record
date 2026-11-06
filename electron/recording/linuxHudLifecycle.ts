type Timer = ReturnType<typeof setTimeout>;
type Recovery = { kind: "none" } | { kind: "requested"; retry: Timer | null };
type State =
	| { kind: "visible" }
	| { kind: "concealed" }
	| { kind: "recovering"; phase: "pending" | "pause-sent"; retry: Timer | null }
	| { kind: "preparing-visible"; owner: symbol }
	| {
			kind: "preparing-hidden";
			owner: symbol;
			placement: "pending" | "concealed";
			recovery: Recovery;
	  }
	| { kind: "cancelled-visible"; owner: symbol }
	| { kind: "cancelled-hidden"; owner: symbol; recovery: Recovery };
type Event =
	| { type: "prepare"; owner: symbol; hide: boolean }
	| { type: "admit"; owner: symbol }
	| { type: "proof"; owner: symbol; retained: boolean }
	| { type: "finish"; owner: symbol }
	| { type: "cancel" | "conceal" | "dismiss" | "recover" | "pause-sent" | "ack" }
	| { type: "show"; capturing: boolean }
	| { type: "schedule" | "tick"; timer: Timer };
export class LinuxHudLifecycle {
	private value: State = { kind: "visible" };
	get state(): Readonly<State> {
		return this.value;
	}
	get preparing() {
		return this.value.kind.startsWith("preparing-") || this.value.kind.startsWith("cancelled-");
	}
	get concealed() {
		return (
			this.value.kind !== "visible" &&
			this.value.kind !== "preparing-visible" &&
			this.value.kind !== "cancelled-visible"
		);
	}
	get recovering() {
		return (
			this.value.kind === "recovering" ||
			((this.value.kind === "preparing-hidden" || this.value.kind === "cancelled-hidden") &&
				this.value.recovery.kind === "requested")
		);
	}
	get pauseSent() {
		return this.value.kind === "recovering" && this.value.phase === "pause-sent";
	}
	get retry(): Timer | null {
		if (this.value.kind === "recovering") return this.value.retry;
		if (
			(this.value.kind === "preparing-hidden" || this.value.kind === "cancelled-hidden") &&
			this.value.recovery.kind === "requested"
		)
			return this.value.recovery.retry;
		return null;
	}
	transition(event: Event): boolean {
		const state = this.value;
		const clear = () => {
			if (this.retry) clearTimeout(this.retry);
		};
		switch (event.type) {
			case "prepare":
				clear();
				this.value = event.hide
					? {
							kind: "preparing-hidden",
							owner: event.owner,
							placement: "pending",
							recovery: { kind: "none" },
						}
					: { kind: "preparing-visible", owner: event.owner };
				return true;
			case "admit":
				if (
					(state.kind === "preparing-visible" || state.kind === "preparing-hidden") &&
					state.owner === event.owner
				)
					return true;
				break;
			case "proof":
				if (
					(state.kind !== "preparing-visible" && state.kind !== "preparing-hidden") ||
					state.owner !== event.owner
				)
					break;
				if (
					state.kind === "preparing-hidden" &&
					(state.recovery.kind === "requested" || state.placement === "concealed")
				)
					return true;
				this.value = event.retained
					? { kind: "preparing-visible", owner: event.owner }
					: {
							kind: "preparing-hidden",
							owner: event.owner,
							placement: "concealed",
							recovery: { kind: "none" },
						};
				return true;
			case "finish":
				if (!this.preparing || !("owner" in state) || state.owner !== event.owner) break;
				this.value =
					state.kind === "preparing-visible" || state.kind === "cancelled-visible"
						? { kind: "visible" }
						: (state.kind === "preparing-hidden" || state.kind === "cancelled-hidden") &&
								state.recovery.kind === "requested"
							? { kind: "recovering", phase: "pending", retry: state.recovery.retry }
							: { kind: "concealed" };
				return true;
			case "cancel":
				clear();
				if (state.kind === "preparing-visible")
					this.value = { kind: "cancelled-visible", owner: state.owner };
				else if (state.kind === "preparing-hidden" || state.kind === "cancelled-hidden")
					this.value = { kind: "cancelled-hidden", owner: state.owner, recovery: { kind: "none" } };
				else if (state.kind === "recovering") this.value = { kind: "concealed" };
				return true;
			case "conceal":
				if (state.kind === "preparing-hidden") this.value = { ...state, placement: "concealed" };
				else if (state.kind === "visible") this.value = { kind: "concealed" };
				else if (state.kind === "preparing-visible")
					this.value = {
						kind: "preparing-hidden",
						owner: state.owner,
						placement: "concealed",
						recovery: { kind: "none" },
					};
				else if (state.kind === "cancelled-visible")
					this.value = { kind: "cancelled-hidden", owner: state.owner, recovery: { kind: "none" } };
				return true;
			case "dismiss":
				clear();
				this.value =
					state.kind === "preparing-visible" || state.kind === "preparing-hidden"
						? {
								kind: "preparing-hidden",
								owner: state.owner,
								placement: "concealed",
								recovery: { kind: "none" },
							}
						: state.kind === "cancelled-visible" || state.kind === "cancelled-hidden"
							? { kind: "cancelled-hidden", owner: state.owner, recovery: { kind: "none" } }
							: { kind: "concealed" };
				return true;
			case "recover":
				if (state.kind === "concealed")
					this.value = { kind: "recovering", phase: "pending", retry: null };
				else if (state.kind === "preparing-hidden" || state.kind === "cancelled-hidden") {
					if (state.recovery.kind === "none")
						this.value = { ...state, recovery: { kind: "requested", retry: null } };
				} else if (state.kind !== "recovering") return false;
				return true;
			case "pause-sent":
				if (state.kind !== "recovering" || state.phase !== "pending") break;
				this.value = { ...state, phase: "pause-sent" };
				return true;
			case "ack":
				if (this.preparing) return false;
				if (state.kind === "recovering") this.value = { ...state, phase: "pending" };
				return true;
			case "show":
				if (this.preparing || event.capturing) break;
				clear();
				this.value = { kind: "visible" };
				return true;
			case "schedule":
				if (this.retry) break;
				if (state.kind === "recovering") this.value = { ...state, retry: event.timer };
				else if (
					(state.kind === "preparing-hidden" || state.kind === "cancelled-hidden") &&
					state.recovery.kind === "requested"
				)
					this.value = { ...state, recovery: { kind: "requested", retry: event.timer } };
				else break;
				return true;
			case "tick":
				if (this.retry !== event.timer) break;
				if (state.kind === "recovering") this.value = { ...state, phase: "pending", retry: null };
				else if (
					(state.kind === "preparing-hidden" || state.kind === "cancelled-hidden") &&
					state.recovery.kind === "requested"
				)
					this.value = { ...state, recovery: { kind: "requested", retry: null } };
				else break;
				return true;
		}
		console.warn("[linux-hud] Illegal transition", { state: state.kind, event: event.type });
		return false;
	}
}

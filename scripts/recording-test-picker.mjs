export class PortalPickerRequests {
	state = { kind: "idle" };

	start() {
		const owner = Symbol("portal-picker");
		this.transition({ type: "start", owner });
		return owner;
	}

	owns(owner) {
		return this.state.kind === "waiting" && this.state.owner === owner;
	}

	transition(event) {
		if (event.type === "start") {
			this.state = { kind: "waiting", owner: event.owner };
			return true;
		}
		if (!this.owns(event.owner)) return false;
		this.state = { kind: "idle" };
		return true;
	}
}

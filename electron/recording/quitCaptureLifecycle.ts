type State = "open" | "stopping" | "completing" | "system-shutdown";
type Event = "stop" | "complete" | "returned" | "system-shutdown";
export class QuitCaptureLifecycle {
	private value: State = "open";
	get state() {
		return this.value;
	}
	transition(event: Event): boolean {
		if (event === "system-shutdown") {
			this.value = "system-shutdown";
			return true;
		}
		if (this.value === "system-shutdown") {
			console.warn("[quit-capture] Illegal transition", { state: this.value, event });
			return false;
		}
		if (event === "stop" && this.value === "open") {
			this.value = "stopping";
			return true;
		}
		if (event === "complete" && this.value === "stopping") {
			this.value = "completing";
			return true;
		}
		if (event === "returned" && this.value === "completing") {
			this.value = "open";
			return true;
		}
		console.warn("[quit-capture] Illegal transition", { state: this.value, event });
		return false;
	}
}

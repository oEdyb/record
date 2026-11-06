type Entry =
	| { kind: "pending-cancel"; at: number }
	| { kind: "active" | "cancelled"; controller: AbortController };
type Event =
	| { type: "cancel"; id: string; at: number }
	| { type: "register"; id: string; at: number; controller: AbortController }
	| { type: "finish"; id: string; controller: AbortController }
	| { type: "prune"; at: number };

export class ExportCancellationRegistry {
	private readonly entries = new Map<string, Entry>();
	constructor(
		private readonly ttlMs = 60_000,
		private readonly maximumPending = 256,
	) {}
	active(id: string): boolean {
		const s = this.entries.get(id);
		return s?.kind === "active" || s?.kind === "cancelled";
	}
	transition(event: Event): boolean {
		if (event.type === "prune") {
			for (const [id, s] of this.entries) {
				if (s.kind !== "pending-cancel") continue;
				if (s.at >= event.at - this.ttlMs) break;
				this.entries.delete(id);
			}
			const pending = [...this.entries].filter(
				(entry): entry is [string, { kind: "pending-cancel"; at: number }] =>
					entry[1].kind === "pending-cancel",
			);
			for (const [id] of pending.slice(0, Math.max(0, pending.length - this.maximumPending)))
				this.entries.delete(id);
			return true;
		}
		if (event.type !== "finish") this.transition({ type: "prune", at: event.at });
		const s = this.entries.get(event.id) ?? { kind: "unregistered" };
		const reject = () => {
			console.warn("[export-cancellation] Illegal transition", {
				state: s.kind,
				event: event.type,
				exportId: event.id,
			});
			return false;
		};
		switch (event.type) {
			case "cancel":
				if (s.kind === "active" || s.kind === "cancelled") {
					this.entries.set(event.id, { kind: "cancelled", controller: s.controller });
					s.controller.abort(new Error("Export cancelled."));
				} else {
					this.entries.set(event.id, { kind: "pending-cancel", at: event.at });
					this.transition({ type: "prune", at: event.at });
				}
				return true;
			case "register":
				if (s.kind === "active" || s.kind === "cancelled") return reject();
				this.entries.set(event.id, {
					kind: s.kind === "pending-cancel" ? "cancelled" : "active",
					controller: event.controller,
				});
				if (s.kind === "pending-cancel") event.controller.abort(new Error("Export cancelled."));
				return true;
			case "finish":
				if ((s.kind !== "active" && s.kind !== "cancelled") || s.controller !== event.controller)
					return reject();
				this.entries.delete(event.id);
				return true;
		}
	}
}

type Kind = "persist" | "update" | "clear";
type Job = { kind: Kind; phase: "queued" | "writing" };
type State =
	| { kind: "idle"; tail: Promise<void> }
	| { kind: "failed"; tail: Promise<void>; error: unknown }
	| { kind: "active"; tail: Promise<void>; jobs: Map<symbol, Job> };
type Event =
	| { type: "queue"; token: symbol; kind: Kind; schedule: (tail: Promise<void>) => Promise<void> }
	| { type: "start"; token: symbol }
	| {
			type: "finish";
			token: symbol;
			outcome: { kind: "success" } | { kind: "failure"; error: unknown };
	  };
export class JournalFileLifecycle {
	private value: State = { kind: "idle", tail: Promise.resolve() };
	get pending() {
		return this.value.tail;
	}
	get settled() {
		return this.value.kind !== "active";
	}
	get state(): Readonly<State> {
		return this.value;
	}
	transition(event: Event): boolean {
		const state = this.value;
		if (event.type === "queue") {
			const jobs = state.kind === "active" ? new Map(state.jobs) : new Map<symbol, Job>();
			if (jobs.has(event.token)) return this.reject(event.type);
			jobs.set(event.token, { kind: event.kind, phase: "queued" });
			this.value = { kind: "active", jobs, tail: event.schedule(state.tail) };
			return true;
		}
		if (state.kind !== "active") return this.reject(event.type);
		const first = state.jobs.entries().next().value;
		if (!first || first[0] !== event.token) return this.reject(event.type);
		const jobs = new Map(state.jobs);
		if (event.type === "start") {
			if (first[1].phase !== "queued") return this.reject(event.type);
			jobs.set(event.token, { ...first[1], phase: "writing" });
			this.value = { ...state, jobs };
			return true;
		}
		if (first[1].phase !== "writing") return this.reject(event.type);
		jobs.delete(event.token);
		this.value = jobs.size
			? { ...state, jobs }
			: event.outcome.kind === "success"
				? { kind: "idle", tail: state.tail }
				: { kind: "failed", tail: state.tail, error: event.outcome.error };
		return true;
	}
	run(kind: Kind, mutation: () => Promise<void>): Promise<void> {
		const token = Symbol(kind);
		if (
			!this.transition({
				type: "queue",
				kind,
				token,
				schedule: (tail) =>
					tail
						.catch(() => undefined)
						.then(async () => {
							if (!this.transition({ type: "start", token }))
								throw new Error("Journal mutation lost ownership.");
							try {
								await mutation();
								this.transition({ type: "finish", token, outcome: { kind: "success" } });
							} catch (error) {
								this.transition({ type: "finish", token, outcome: { kind: "failure", error } });
								throw error;
							}
						}),
			})
		)
			return Promise.reject(new Error("Journal mutation was rejected."));
		return this.pending;
	}
	private reject(event: Event["type"]) {
		console.warn("[journal-file] Illegal transition", { state: this.value.kind, event });
		return false;
	}
}

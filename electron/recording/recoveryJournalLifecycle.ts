type MutationKind = "snapshot" | "remove" | "restore" | "publish" | "clear";
type Phase = "open" | "publishing" | "published" | "discarding" | "discarded";
type Job = { kind: MutationKind; phase: "queued" | "writing" };
type Owner = { generation: number; recordingId: number };
type Bound = Owner & { tail: Promise<void>; jobs: Map<symbol, Job> } & (
		| { kind: Phase }
		| { kind: "failed"; previous: Phase; error: unknown }
	);
type State =
	| { kind: "unbound"; tail: Promise<void> }
	| { kind: "retired"; owner: Owner; tail: Promise<void> }
	| Bound;
type Event =
	| { type: "bind"; owner: Owner }
	| { type: "retire"; generation: number }
	| {
			type: "queue";
			generation: number;
			token: symbol;
			kind: MutationKind;
			schedule: (previous: Promise<void>) => Promise<void>;
	  }
	| { type: "start"; generation: number; token: symbol }
	| {
			type: "finish";
			generation: number;
			token: symbol;
			outcome: { kind: "success" } | { kind: "failure"; error: unknown };
	  };
export class RecoveryJournalLifecycle {
	private value: State = { kind: "unbound", tail: Promise.resolve() };
	get pending() {
		return this.value.tail;
	}
	get state(): Readonly<State> {
		return this.value;
	}
	transition(event: Event): boolean {
		const state = this.value;
		if (event.type === "bind") {
			const previous =
				"generation" in state
					? state.generation
					: state.kind === "retired"
						? state.owner.generation
						: -1;
			if (event.owner.generation <= previous) return this.reject(event);
			this.value = { kind: "open", ...event.owner, tail: state.tail, jobs: new Map() };
			return true;
		}
		if (event.type === "retire") {
			if (state.kind === "unbound") return true;
			const owner =
				state.kind === "retired"
					? state.owner
					: { generation: state.generation, recordingId: state.recordingId };
			if (owner.generation !== event.generation) return this.reject(event);
			this.value = { kind: "retired", owner, tail: state.tail };
			return true;
		}
		if (!("generation" in state) || state.generation !== event.generation)
			return this.reject(event);
		const phase = state.kind === "failed" ? state.previous : state.kind;
		const jobs = new Map(state.jobs);
		switch (event.type) {
			case "queue": {
				if (jobs.has(event.token) || phase !== "open") return this.reject(event);
				jobs.set(event.token, { kind: event.kind, phase: "queued" });
				this.value = {
					...state,
					kind:
						event.kind === "publish"
							? "publishing"
							: event.kind === "clear"
								? "discarding"
								: "open",
					jobs,
					tail: event.schedule(state.tail),
				};
				return true;
			}
			case "start": {
				const job = jobs.get(event.token);
				if (!job || job.phase !== "queued") return this.reject(event);
				jobs.set(event.token, { ...job, phase: "writing" });
				this.value = { ...state, jobs };
				return true;
			}
			case "finish": {
				const job = jobs.get(event.token);
				if (!job || job.phase !== "writing") return this.reject(event);
				jobs.delete(event.token);
				this.value =
					event.outcome.kind === "failure"
						? { ...state, kind: "failed", previous: phase, error: event.outcome.error, jobs }
						: {
								...state,
								kind:
									job.kind === "publish" ? "published" : job.kind === "clear" ? "discarded" : phase,
								jobs,
							};
				return true;
			}
		}
	}
	write(generation: number, kind: MutationKind, mutation: () => Promise<void>): Promise<void> {
		const token = Symbol(kind);
		const accepted = this.transition({
			type: "queue",
			generation,
			token,
			kind,
			schedule: (previous) =>
				previous
					.catch(() => undefined)
					.then(async () => {
						if (!this.transition({ type: "start", generation, token }))
							throw new Error("Stale journal mutation was rejected.");
						try {
							await mutation();
							this.transition({ type: "finish", generation, token, outcome: { kind: "success" } });
						} catch (error) {
							this.transition({
								type: "finish",
								generation,
								token,
								outcome: { kind: "failure", error },
							});
							throw error;
						}
					}),
		});
		return accepted
			? this.pending
			: Promise.reject(new Error("Recovery journal is no longer open for this recording."));
	}

	private reject(event: Event) {
		console.warn("[recovery-journal] Illegal transition", {
			state: this.value.kind,
			event: event.type,
		});
		return false;
	}
}

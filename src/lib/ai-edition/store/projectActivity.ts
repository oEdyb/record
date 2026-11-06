type Idle = { kind: "idle"; latest: number };
type Active = {
	kind: "active";
	latest: number;
	mutations: Set<number>;
	saves: Set<symbol>;
	waiters: Array<() => void>;
};
type Activity = Idle | Active;
type Event =
	| { type: "begin"; operation: number }
	| { type: "finish"; operation: number }
	| { type: "queue"; token: symbol }
	| { type: "dequeue"; token: symbol }
	| { type: "wait"; resolve: () => void };
export class ProjectActivity {
	private value = new Map<string, Activity>();
	private sequence = 0;
	generation(projectId: string) {
		return this.value.get(projectId)?.latest ?? 0;
	}
	active(projectId: string) {
		const value = this.value.get(projectId);
		return value?.kind === "active" ? value.mutations.size : 0;
	}
	queued(projectId: string) {
		const value = this.value.get(projectId);
		return value?.kind === "active" ? value.saves.size : 0;
	}
	begin(projectId: string) {
		const operation = ++this.sequence;
		this.transition(projectId, { type: "begin", operation });
		return operation;
	}
	transition(projectId: string, event: Event): boolean {
		const old = this.value.get(projectId) ?? { kind: "idle", latest: 0 };
		const next: Active =
			old.kind === "active"
				? {
						...old,
						mutations: new Set(old.mutations),
						saves: new Set(old.saves),
						waiters: [...old.waiters],
					}
				: {
						kind: "active",
						latest: old.latest,
						mutations: new Set(),
						saves: new Set(),
						waiters: [],
					};
		switch (event.type) {
			case "begin":
				next.mutations.add(event.operation);
				next.latest = event.operation;
				break;
			case "finish":
				if (!next.mutations.delete(event.operation)) return this.reject(projectId, event);
				break;
			case "queue":
				if (next.saves.has(event.token)) return this.reject(projectId, event);
				next.saves.add(event.token);
				break;
			case "dequeue":
				if (!next.saves.delete(event.token)) return this.reject(projectId, event);
				break;
			case "wait":
				if (!next.mutations.size) {
					event.resolve();
					return true;
				}
				next.waiters.push(event.resolve);
				break;
		}
		const waiters = next.mutations.size ? [] : next.waiters.splice(0);
		this.value.set(
			projectId,
			next.mutations.size || next.saves.size ? next : { kind: "idle", latest: next.latest },
		);
		for (const resolve of waiters) resolve();
		return true;
	}
	private reject(projectId: string, event: Event) {
		console.warn("[project-activity] Illegal transition", { projectId, event: event.type });
		return false;
	}
}

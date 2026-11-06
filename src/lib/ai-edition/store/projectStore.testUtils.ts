import type { ProjectLifecycle } from "./projectLifecycle";
import { type ProjectState, projectSnapshot, useProjectStore } from "./projectStore";
export function seedProjectState(patch: Partial<ProjectState>) {
	const before = useProjectStore.getState();
	let editing = before.lifecycle.editing;
	if (patch.transactionBusy === false && patch.transactionSyncPending === false)
		editing = { kind: "editable", request: null };
	else if (patch.transactionSyncPending === true)
		editing = { kind: "blocked", reason: { request: null, copy: null } };
	else if (patch.transactionBusy === true)
		editing = {
			kind: "recovering",
			owner: Symbol("fixture"),
			reason: { request: null, copy: null },
		};
	const lifecycle: ProjectLifecycle = {
		epoch: before.lifecycle.epoch,
		view:
			patch.status === "loading"
				? {
						kind: "loading",
						error: patch.error ?? null,
						previous:
							before.lifecycle.view.kind === "loading"
								? before.lifecycle.view.previous
								: before.lifecycle.view,
					}
				: patch.status
					? { kind: patch.status, error: patch.error === undefined ? before.error : patch.error }
					: {
							...before.lifecycle.view,
							error: patch.error === undefined ? before.error : patch.error,
						},
		editing,
		draft: { ...before.lifecycle.draft, kind: (patch.dirty ?? before.dirty) ? "dirty" : "clean" },
	};
	useProjectStore.setState(projectSnapshot({ ...before, ...patch, lifecycle }), true);
}

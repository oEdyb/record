import type { AiEditionProjectVersion, AiEditionWriteGuard } from "@/native/contracts";
import type { AxcutDocument } from "../schema";

export type LocalRequest = {
	kind: "local";
	projectId: string;
	requestId: string;
	expected: AiEditionProjectVersion;
	candidate: AxcutDocument;
	base: AxcutDocument | null;
};
type ExternalRequest = { kind: "external"; projectId: string; guard: AiEditionWriteGuard };
export type ProjectRequest = LocalRequest | ExternalRequest;
type Copy = { projectId: string; revision: number; copyId: string };
type Reason = { request: ProjectRequest | null; copy: Copy | null };
type Editing =
	| { kind: "editable"; request: LocalRequest | null }
	| { kind: "external"; owner: symbol; request: ExternalRequest; outcome: "pending" | Reason }
	| { kind: "blocked"; reason: Reason }
	| { kind: "recovering"; owner: symbol; reason: Reason };
type StableView = { kind: "idle" | "ready" | "error"; error: string | null };
type View = StableView | { kind: "loading"; error: string | null; previous: StableView };
type Draft = {
	kind: "clean" | "dirty";
	base: { document: AxcutDocument; before: AxcutDocument } | null;
};
export type ProjectLifecycle = {
	epoch: number;
	view: View;
	editing: Editing;
	draft: Draft;
};
export type ProjectEvent =
	| { type: "load" }
	| { type: "view"; view: Pick<View, "kind" | "error"> }
	| { type: "cancel-load"; epoch: number; diagnostic?: "current" | "previous" }
	| { type: "draft"; kind: Draft["kind"] }
	| { type: "publish-draft"; document: AxcutDocument; previous: AxcutDocument | null }
	| { type: "checkpoint"; document: AxcutDocument }
	| { type: "local-request"; request: LocalRequest }
	| { type: "request-confirmed"; requestId: string }
	| { type: "block" }
	| { type: "external"; owner: symbol; projectId: string; guard: AiEditionWriteGuard }
	| { type: "recover"; owner: symbol }
	| { type: "copy"; owner: symbol; copy: Copy }
	| { type: "finish"; owner: symbol }
	| { type: "reconciled" }
	| { type: "reset" };
export const initialProjectLifecycle = (): ProjectLifecycle => ({
	epoch: 0,
	view: { kind: "idle", error: null },
	editing: { kind: "editable", request: null },
	draft: { kind: "clean", base: null },
});
export function projectBusy(value: ProjectLifecycle) {
	return value.editing.kind === "external" || value.editing.kind === "recovering";
}
export function projectSyncPending(value: ProjectLifecycle) {
	return (
		value.editing.kind === "blocked" ||
		value.editing.kind === "recovering" ||
		(value.editing.kind === "external" && value.editing.outcome !== "pending")
	);
}
export function projectRequest(value: ProjectLifecycle): ProjectRequest | null {
	const edit = value.editing;
	return edit.kind === "editable" || edit.kind === "external" ? edit.request : edit.reason.request;
}
export function projectCopy(value: ProjectLifecycle): Copy | null {
	const edit = value.editing;
	return edit.kind === "blocked" || edit.kind === "recovering" ? edit.reason.copy : null;
}
export function transitionProject(value: ProjectLifecycle, event: ProjectEvent): ProjectLifecycle {
	const edit = value.editing;
	switch (event.type) {
		case "load":
			if (edit.kind !== "editable" || edit.request) break;
			return {
				...value,
				epoch: value.epoch + 1,
				view: {
					kind: "loading",
					error: null,
					previous: value.view.kind === "loading" ? value.view.previous : value.view,
				},
			};
		case "cancel-load":
			if (value.view.kind !== "loading" || value.epoch !== event.epoch) break;
			return {
				...value,
				view: {
					...value.view.previous,
					error: event.diagnostic === "current" ? value.view.error : value.view.previous.error,
				},
			};
		case "view": {
			if (event.view.kind === "loading") {
				if (value.view.kind !== "loading") break;
				return { ...value, view: { ...value.view, error: event.view.error } };
			}
			if (
				(value.view.kind === "idle" && event.view.kind === "ready") ||
				(value.view.kind === "ready" && event.view.kind === "idle")
			)
				break;
			return { ...value, view: { kind: event.view.kind, error: event.view.error } };
		}
		case "draft":
			return { ...value, draft: { ...value.draft, kind: event.kind } };
		case "publish-draft":
			if (edit.kind !== "editable") break;
			return {
				...value,
				draft: {
					kind: "dirty",
					base: event.previous
						? {
								document: event.document,
								before:
									value.draft.base?.document === event.previous
										? value.draft.base.before
										: event.previous,
							}
						: null,
				},
			};
		case "checkpoint":
			return {
				...value,
				draft: { ...value.draft, base: { document: event.document, before: event.document } },
			};
		case "local-request":
			if (edit.kind !== "editable" || edit.request) break;
			return { ...value, editing: { kind: "editable", request: event.request } };
		case "request-confirmed":
			if (edit.kind === "editable" && edit.request?.requestId === event.requestId)
				return { ...value, editing: { kind: "editable", request: null } };
			if (edit.kind === "external" && edit.request.guard.requestId === event.requestId)
				return value;
			break;
		case "block": {
			if (edit.kind === "blocked" || edit.kind === "recovering") return value;
			const reason: Reason = { request: edit.request, copy: null };
			return {
				...value,
				editing:
					edit.kind === "external" ? { ...edit, outcome: reason } : { kind: "blocked", reason },
			};
		}
		case "external":
			if (edit.kind !== "editable" || edit.request) break;
			return {
				...value,
				editing: {
					kind: "external",
					owner: event.owner,
					request: { kind: "external", projectId: event.projectId, guard: event.guard },
					outcome: "pending",
				},
			};
		case "recover":
			if (edit.kind === "editable" && !edit.request)
				return {
					...value,
					editing: {
						kind: "recovering",
						owner: event.owner,
						reason: { request: null, copy: null },
					},
				};
			if (edit.kind !== "blocked") break;
			return { ...value, editing: { kind: "recovering", owner: event.owner, reason: edit.reason } };
		case "copy":
			if (edit.kind !== "recovering" || edit.owner !== event.owner) break;
			return { ...value, editing: { ...edit, reason: { ...edit.reason, copy: event.copy } } };
		case "finish":
			if ((edit.kind !== "external" && edit.kind !== "recovering") || edit.owner !== event.owner)
				break;
			if (edit.kind === "recovering")
				return { ...value, editing: { kind: "blocked", reason: edit.reason } };
			return {
				...value,
				editing:
					edit.outcome === "pending"
						? { kind: "editable", request: null }
						: { kind: "blocked", reason: edit.outcome },
			};
		case "reconciled":
			if (edit.kind !== "blocked" && edit.kind !== "recovering") break;
			return {
				...value,
				editing: { kind: "editable", request: null },
				draft: { kind: "clean", base: null },
			};
		case "reset":
			if (edit.kind !== "editable" || edit.request) break;
			return { ...initialProjectLifecycle(), epoch: value.epoch + 1 };
	}
	console.warn("[project-lifecycle] Illegal transition", {
		view: value.view.kind,
		editing: edit.kind,
		event: event.type,
	});
	throw new ProjectLifecycleRejection();
}
export class ProjectLifecycleRejection extends Error {
	readonly code = "EDITOR_BUSY";
	constructor() {
		super("Finish the current project operation before starting another.");
	}
}

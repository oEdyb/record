import { expect, it, vi } from "vitest";
import { ProjectActivity } from "./projectActivity";
import {
	initialProjectLifecycle,
	projectRequest,
	projectSyncPending,
	transitionProject,
} from "./projectLifecycle";

it("rejects stale recovery completion without releasing a newer owner's barrier", () => {
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const blocked = transitionProject(initialProjectLifecycle(), { type: "block" });
	const owner = Symbol("new-recovery");
	const recovering = transitionProject(blocked, { type: "recover", owner });
	expect(() =>
		transitionProject(recovering, { type: "finish", owner: Symbol("old-recovery") }),
	).toThrow();
	expect(projectSyncPending(recovering)).toBe(true);
	expect(log).toHaveBeenCalledWith(
		"[project-lifecycle] Illegal transition",
		expect.objectContaining({ event: "finish" }),
	);
	expect(transitionProject(recovering, { type: "finish", owner }).editing.kind).toBe("blocked");
	log.mockRestore();
});
it("rejects reset and another external commit while the exact uncertain request needs recovery", () => {
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const guard = {
		requestId: "must-recover",
		expected: { revision: "one", fileHash: "hash", mutationIdentity: "identity" },
	};
	const owner = Symbol("external");
	const committing = transitionProject(initialProjectLifecycle(), {
		type: "external",
		owner,
		projectId: "project",
		guard,
	});
	const uncertain = transitionProject(transitionProject(committing, { type: "block" }), {
		type: "finish",
		owner,
	});
	expect(() => transitionProject(uncertain, { type: "reset" })).toThrow();
	expect(() =>
		transitionProject(uncertain, { type: "external", owner: Symbol(), projectId: "other", guard }),
	).toThrow();
	expect(projectRequest(uncertain)).toMatchObject({ kind: "external", guard });
	expect(log).toHaveBeenCalledTimes(2);
	log.mockRestore();
});
it("rejects duplicate mutation completion without releasing the remaining save or idle waiter", () => {
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const activity = new ProjectActivity();
	const first = activity.begin("project");
	const second = activity.begin("project");
	const idle = vi.fn();
	activity.transition("project", { type: "wait", resolve: idle });
	expect(activity.transition("project", { type: "finish", operation: first })).toBe(true);
	expect(activity.transition("project", { type: "finish", operation: first })).toBe(false);
	expect(activity.active("project")).toBe(1);
	expect(idle).not.toHaveBeenCalled();
	activity.transition("project", { type: "finish", operation: second });
	expect(idle).toHaveBeenCalledOnce();
	expect(log).toHaveBeenCalledOnce();
	log.mockRestore();
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JournalFileLifecycle } from "./journalFileLifecycle";
import { RecoveryJournalLifecycle } from "./recoveryJournalLifecycle";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = () => done();
	});
	return { promise, resolve };
}
async function scratch() {
	const base = path.join(os.homedir(), ".cache", "klippt-work", "journal-lifecycle-tests");
	await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	roots.push(root);
	return path.join(root, "journal.json");
}
it("rejects an update after publication without invoking its write or losing saved bytes", async () => {
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const owner = new RecoveryJournalLifecycle();
	const file = await scratch();
	owner.transition({ type: "bind", owner: { generation: 1, recordingId: 10 } });
	await owner.write(1, "publish", () => fs.writeFile(file, "published take"));
	const rejected = vi.fn(() => fs.writeFile(file, "stale metadata"));
	await expect(owner.write(1, "snapshot", rejected)).rejects.toThrow("no longer open");
	expect(rejected).not.toHaveBeenCalled();
	expect(await fs.readFile(file, "utf8")).toBe("published take");
	expect(owner.state.kind).toBe("published");
	expect(log).toHaveBeenCalledWith("[recovery-journal] Illegal transition", {
		state: "published",
		event: "queue",
	});
});
it("keeps a replacement behind an old in-flight write and rejects retired queued mutations", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const owner = new RecoveryJournalLifecycle();
	const file = await scratch();
	const entered = deferred();
	const finish = deferred();
	owner.transition({ type: "bind", owner: { generation: 1, recordingId: 10 } });
	const first = owner.write(1, "snapshot", async () => {
		entered.resolve();
		await finish.promise;
		await fs.writeFile(file, "old complete snapshot");
	});
	await entered.promise;
	const staleWrite = vi.fn(() => fs.writeFile(file, "must not run"));
	const stale = owner.write(1, "remove", staleWrite);
	const staleOutcome = stale.then(
		() => "accepted",
		() => "rejected",
	);
	owner.transition({ type: "retire", generation: 1 });
	owner.transition({ type: "bind", owner: { generation: 2, recordingId: 11 } });
	const nextWrite = vi.fn(() => fs.writeFile(file, "replacement snapshot"));
	const next = owner.write(2, "snapshot", nextWrite);
	await Promise.resolve();
	expect(nextWrite).not.toHaveBeenCalled();
	finish.resolve();
	await first;
	await next;
	expect(await staleOutcome).toBe("rejected");
	expect(staleWrite).not.toHaveBeenCalled();
	expect(await fs.readFile(file, "utf8")).toBe("replacement snapshot");
	expect(owner.state).toMatchObject({ kind: "open", generation: 2 });
	expect(owner.transition({ type: "retire", generation: 1 })).toBe(false);
	expect(owner.transition({ type: "bind", owner: { generation: 1, recordingId: 10 } })).toBe(false);
	expect(owner.state).toMatchObject({ kind: "open", generation: 2 });
});
it("retains failed-write diagnosis and admits a later complete publication", async () => {
	const owner = new RecoveryJournalLifecycle();
	const file = await scratch();
	owner.transition({ type: "bind", owner: { generation: 1, recordingId: 10 } });
	await expect(
		owner.write(1, "remove", async () => {
			throw new Error("disk full");
		}),
	).rejects.toThrow("disk full");
	expect(owner.state).toMatchObject({ kind: "failed", previous: "open" });
	await owner.write(1, "publish", () => fs.writeFile(file, "recoverable take"));
	expect(owner.state.kind).toBe("published");
	expect(await fs.readFile(file, "utf8")).toBe("recoverable take");
});
it("rejects duplicate filesystem completion without releasing the next queued mutation", async () => {
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const owner = new JournalFileLifecycle();
	const entered = deferred();
	const finish = deferred();
	const first = owner.run("persist", async () => {
		entered.resolve();
		await finish.promise;
	});
	await entered.promise;
	const state = owner.state;
	if (state.kind !== "active") throw new Error("journal should be writing");
	const token = state.jobs.keys().next().value;
	if (!token) throw new Error("journal should retain the current token");
	const next = vi.fn(async () => undefined);
	const second = owner.run("update", next);
	expect(
		owner.transition({ type: "finish", token: Symbol("unowned"), outcome: { kind: "success" } }),
	).toBe(false);
	expect(next).not.toHaveBeenCalled();
	finish.resolve();
	await first;
	await second;
	const settled = owner.state;
	expect(owner.transition({ type: "finish", token, outcome: { kind: "success" } })).toBe(false);
	expect(owner.state).toBe(settled);
	expect(next).toHaveBeenCalledOnce();
	expect(log).toHaveBeenCalledTimes(2);
});

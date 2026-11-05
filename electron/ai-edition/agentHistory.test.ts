// @vitest-environment node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentHistoryIntent, AgentHistoryStore } from "./agentHistory";
import { DocumentService } from "./document-service";
import { ProjectTransactionStore } from "./projectTransactions";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
async function setup() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-history-"));
	directories.push(directory);
	const service = new DocumentService(directory, directory);
	const doc = await service.createProject("Initial");
	const id = doc.project.id;
	const file = path.join(directory, `${id}.klippt`);
	let sequence = 0;
	const edit = async (title: string, agent = true, requestId?: string) => {
		const snapshot = await service.getTransactionSnapshot(id);
		return service.commitTransaction(
			id,
			{
				requestId: requestId ?? `edit-${++sequence}`,
				payload: { title },
				expected: snapshot.version,
				recordUndo: true,
				...(agent
					? {
							agentHistory: {
								kind: "apply",
								targetIds: [],
								force: false,
								planSummary: "1 operations: set-layout",
							} satisfies AgentHistoryIntent,
						}
					: {}),
			},
			(document) => ({ ...document, project: { ...document.project, title } }),
		);
	};
	const restore = async (
		kind: "undo" | "redo",
		input: { steps?: number; to?: string; force?: boolean } = {},
	) => {
		const planned = await service.prepareAgentRestore(id, kind, input);
		return service.commitTransaction(
			id,
			{
				requestId: `restore-${++sequence}`,
				payload: { kind, input },
				expected: planned.version,
				recordUndo: true,
				agentHistory: planned.intent,
			},
			() => planned.document,
		);
	};
	return {
		directory,
		service,
		id,
		file,
		edit,
		restore,
		title: async () => (await service.getTransactionSnapshot(id)).document.project.title,
	};
}
describe("durable agent history", () => {
	it("migrates a retained old-schema snapshot before undo", async () => {
		const s = await setup();
		await s.edit("Changed");
		const [entry] = await new AgentHistoryStore(s.file).list();
		const file = path.join(`${s.file}.history`, entry.snapshotPath);
		const raw = JSON.parse(gunzipSync(await fs.readFile(file)).toString("utf8"));
		raw.schemaVersion = 7;
		await fs.writeFile(file, gzipSync(JSON.stringify(raw)));
		await s.restore("undo");
		expect(await s.title()).toBe("Initial");
	});

	it("restores a retained undo entry's before-document with --to and can redo it", async () => {
		const s = await setup();
		await s.edit("A");
		await s.edit("B");
		await s.restore("undo");
		const undoId = (await s.service.getAgentHistory(s.id))[0].applyId;
		await s.edit("C");
		await s.restore("undo", { to: undoId });
		expect(await s.title()).toBe("B");
		await s.restore("redo");
		expect(await s.title()).toBe("C");
		await s.restore("undo");
		expect(await s.title()).toBe("B");
	});
	it("refuses an inactive checkpoint across a non-agent edit unless forced", async () => {
		const s = await setup();
		const a = await s.edit("A");
		await s.restore("undo");
		await s.edit("Human", false);
		await s.edit("B");
		await expect(s.restore("undo", { to: a.operationId })).rejects.toThrow("HISTORY_CONFLICT");
		await s.restore("undo", { to: a.operationId, force: true });
		expect(await s.title()).toBe("Initial");
		await s.restore("redo");
		expect(await s.title()).toBe("B");
	});

	it("continues redo after pruning its earlier target entry", async () => {
		const s = await setup();
		for (let i = 1; i <= 49; i++) await s.edit(`Edit ${i}`);
		await s.restore("undo", { steps: 49 });
		await s.restore("redo");
		await s.restore("redo");
		expect(await s.title()).toBe("Edit 2");
	});
	it("appends and prunes to 50 entries and 100 gzip snapshots", async () => {
		const s = await setup();
		for (let i = 0; i < 53; i++) await s.edit(`Edit ${i}`);
		const history = await s.service.getAgentHistory(s.id);
		expect(history).toHaveLength(50);
		expect(history[0].requestId).toBe("edit-53");
		expect(history.at(-1)?.requestId).toBe("edit-4");
		expect((await fs.readdir(`${s.file}.history`)).filter((p) => p.endsWith(".gz"))).toHaveLength(
			100,
		);
	});
	it("round trips multiple steps, --to, repeated undo and restart through the real document service", async () => {
		const s = await setup();
		const a = await s.edit("One");
		await s.edit("Two");
		await s.edit("Three");
		await s.restore("undo", { steps: 2 });
		expect(await s.title()).toBe("One");
		await s.restore("redo");
		expect(await s.title()).toBe("Two");
		await s.restore("redo");
		expect(await s.title()).toBe("Three");
		await s.restore("undo", { to: a.operationId });
		expect(await s.title()).toBe("Initial");
		await s.restore("redo", { steps: 3 });
		expect(await s.title()).toBe("Three");
		await s.restore("undo");
		await s.restore("undo");
		expect(await s.title()).toBe("One");
		const restarted = new DocumentService(s.directory, s.directory);
		expect((await restarted.prepareAgentRestore(s.id, "redo", {})).document.project.title).toBe(
			"Two",
		);
		expect((await restarted.getAgentHistory(s.id))[0].planSummary).toMatch(/^undo /);
	});
	it("refuses intervening edits by revision and allows explicit force without weakening the commit guard", async () => {
		const s = await setup();
		await s.edit("Agent");
		await s.edit("Human", false);
		await expect(s.restore("undo")).rejects.toThrow("HISTORY_CONFLICT");
		await s.restore("undo", { force: true });
		expect(await s.title()).toBe("Initial");
		await s.edit("Human again", false);
		await expect(s.restore("redo")).rejects.toThrow("HISTORY_CONFLICT");
		const forced = await s.service.prepareAgentRestore(s.id, "redo", { force: true });
		await s.edit("Another edit", false);
		await expect(
			s.service.commitTransaction(
				s.id,
				{ requestId: "stale", expected: forced.version, payload: {}, agentHistory: forced.intent },
				() => forced.document,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("detects gaps between agent edits even across separate undo calls", async () => {
		const s = await setup();
		await s.edit("A");
		await s.edit("Human", false);
		await s.edit("B");
		await expect(s.restore("undo", { steps: 2 })).rejects.toThrow("HISTORY_CONFLICT");
		await s.restore("undo");
		expect(await s.title()).toBe("Human");
		await expect(s.restore("undo")).rejects.toThrow("HISTORY_CONFLICT");
	});
	it("a new edit after undo clears redo and can itself be undone", async () => {
		const s = await setup();
		await s.edit("A");
		await s.edit("B");
		await s.restore("undo");
		await s.edit("C");
		await expect(s.restore("redo")).rejects.toThrow("HISTORY_UNAVAILABLE");
		await s.restore("undo");
		expect(await s.title()).toBe("A");
		await s.restore("undo");
		expect(await s.title()).toBe("Initial");
	});
	it.each([
		"before-rename",
		"after-rename",
	] as const)("recovers journal at %s without duplicate entries", async (stage) => {
		const s = await setup();
		const snapshot = await s.service.getTransactionSnapshot(s.id);
		const store = new ProjectTransactionStore(s.file, {
			fault: (at) => {
				if (at === stage) throw new Error("crash");
			},
		});
		await expect(
			store.commit(
				{
					requestId: "crash",
					payload: {},
					expected: snapshot.version,
					recordUndo: true,
					agentHistory: { kind: "apply", targetIds: [], force: false, planSummary: "fault" },
				},
				(doc) => ({ ...doc, project: { ...doc.project, title: "Recovered" } }),
			),
		).rejects.toThrow();
		const history = await s.service.getAgentHistory(s.id);
		expect(history).toHaveLength(stage === "after-rename" ? 1 : 0);
		expect(await s.service.getAgentHistory(s.id)).toEqual(history);
		expect(await new AgentHistoryStore(s.file).list()).toEqual(history);
	});
	it("reverts a whole batch group in one undo when --to names the shared request-id prefix", async () => {
		const s = await setup();
		const group = randomUUID();
		await s.edit("Batch 1", true, `${group}:0`);
		await s.edit("Batch 2", true, `${group}:1`);
		await s.edit("Batch 3", true, `${group}:2`);
		await s.restore("undo", { to: group });
		expect(await s.title()).toBe("Initial");
		await s.restore("redo", { steps: 3 });
		expect(await s.title()).toBe("Batch 3");
	});
	it("group undo also reverts edits applied after the batch", async () => {
		const s = await setup();
		const group = randomUUID();
		await s.edit("Batch 1", true, `${group}:0`);
		await s.edit("Batch 2", true, `${group}:1`);
		await s.edit("Later");
		await s.restore("undo", { to: group });
		expect(await s.title()).toBe("Initial");
	});
	it("a group partially undone resolves to its entries still on the undo stack", async () => {
		const s = await setup();
		const group = randomUUID();
		await s.edit("Batch 1", true, `${group}:0`);
		await s.edit("Batch 2", true, `${group}:1`);
		await s.restore("undo");
		expect(await s.title()).toBe("Batch 1");
		await s.restore("undo", { to: group });
		expect(await s.title()).toBe("Initial");
	});
	it("refuses a group id that names no retained entry", async () => {
		const s = await setup();
		await s.edit("A", true, `${randomUUID()}:0`);
		await expect(s.restore("undo", { to: randomUUID() })).rejects.toThrow("HISTORY_UNAVAILABLE");
	});
});

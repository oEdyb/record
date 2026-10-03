import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { z } from "zod";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import type { ProjectTransactionReceipt, ProjectTransactionVersion } from "./projectTransactions";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const agentHistoryIntentSchema = z.strictObject({
	planSummary: z.string().min(1).max(2048),
	requestKey: z.string().max(4096).optional(),
	restoreTo: z.string().uuid().optional(),
	kind: z.enum(["apply", "undo", "redo"]).default("apply"),
	targetIds: z.array(z.string().uuid()).max(50).default([]),
	force: z.boolean().default(false),
});
export type AgentHistoryIntent = z.infer<typeof agentHistoryIntentSchema>;
const entrySchema = z.strictObject({
	applyId: z.string().uuid(),
	requestId: z.string().min(1).max(256),
	at: z.string(),
	planSummary: z.string(),
	requestKey: z.string().optional(),
	restoreTo: z.string().uuid().optional(),
	beforeRevision: z.string(),
	beforeStateRevision: z.string(),
	afterStateRevision: z.string(),
	afterRevision: z.string(),
	beforeFileHash: z.string(),
	afterFileHash: z.string(),
	snapshotPath: z.string().regex(/^[a-f0-9-]+\.before\.json\.gz$/),
	afterSnapshotPath: z.string().regex(/^[a-f0-9-]+\.after\.json\.gz$/),
	kind: z.enum(["apply", "undo", "redo"]),
	targetIds: z.array(z.string()),
});
export type AgentHistoryEntry = z.infer<typeof entrySchema>;
const indexSchema = z.strictObject({
	version: z.literal(1),
	entries: z.array(entrySchema).max(50),
	undo: z.array(z.string()).max(50),
	redo: z.array(z.string()).max(50),
});
type HistoryIndex = z.infer<typeof indexSchema>;
const empty = (): HistoryIndex => ({ version: 1, entries: [], undo: [], redo: [] });

async function atomicWrite(file: string, contents: string | Buffer) {
	const temp = `${file}.tmp-${randomUUID()}`;
	try {
		await fs.writeFile(temp, contents, { flag: "wx", mode: 0o600, flush: true });
		await fs.rename(temp, file);
		const directory = await fs.open(path.dirname(file), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await fs.unlink(temp).catch(() => undefined);
	}
}
async function readJson(file: string): Promise<unknown | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export class AgentHistoryStore {
	readonly directory: string;
	constructor(projectPath: string) {
		this.directory = `${projectPath}.history`;
	}
	private file(name: string) {
		return path.join(this.directory, name);
	}
	private async index() {
		return indexSchema.parse((await readJson(this.file("index.json"))) ?? empty());
	}

	async recover(receipts: readonly ProjectTransactionReceipt[]) {
		const raw = await readJson(this.file("pending.json"));
		if (!raw) return;
		const pending = entrySchema.parse(raw);
		const committed = receipts.some(
			(r) => r.operationId === pending.applyId && r.revision === pending.afterRevision,
		);
		if (committed) await this.finish(pending);
		else {
			await fs.unlink(this.file("pending.json"));
			await Promise.all(
				[pending.snapshotPath, pending.afterSnapshotPath].map((file) =>
					fs.unlink(this.file(file)).catch(() => undefined),
				),
			);
		}
	}
	async list() {
		return (await this.index()).entries.slice().reverse();
	}
	async prepare(
		before: AxcutDocument,
		after: AxcutDocument,
		version: ProjectTransactionVersion,
		receipt: ProjectTransactionReceipt,
		afterFileHash: string,
		intent: AgentHistoryIntent,
	) {
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		if (!(await fs.lstat(this.directory)).isDirectory())
			throw new Error("HISTORY_INVALID: Expected a regular directory.");
		let restoredStateRevision: string | undefined;
		if (intent.kind !== "apply") {
			const selected = await this.select(intent.kind, version, {
				...(intent.restoreTo ? { to: intent.restoreTo } : { steps: intent.targetIds.length }),
				force: intent.force,
			});
			restoredStateRevision = selected.stateRevision;
			if (JSON.stringify(selected.targetIds) !== JSON.stringify(intent.targetIds))
				throw new Error("HISTORY_CONFLICT: History changed during restore.");
		}
		const head = (await this.index()).entries.at(-1);
		const entry: AgentHistoryEntry = {
			applyId: receipt.operationId,
			requestId: receipt.requestId,
			at: new Date().toISOString(),
			planSummary: intent.planSummary,
			beforeRevision: version.revision,
			afterRevision: receipt.revision,
			beforeFileHash: version.fileHash,
			afterFileHash,
			beforeStateRevision:
				head?.afterRevision === version.revision && head.afterFileHash === version.fileHash
					? head.afterStateRevision
					: version.revision,
			afterStateRevision: restoredStateRevision ?? receipt.revision,
			snapshotPath: `${receipt.operationId}.before.json.gz`,
			afterSnapshotPath: `${receipt.operationId}.after.json.gz`,
			kind: intent.kind,
			targetIds: intent.targetIds,
			...(intent.requestKey ? { requestKey: intent.requestKey } : {}),
			...(intent.restoreTo ? { restoreTo: intent.restoreTo } : {}),
		};
		await atomicWrite(this.file(entry.snapshotPath), await compress(JSON.stringify(before)));
		await atomicWrite(this.file(entry.afterSnapshotPath), await compress(JSON.stringify(after)));
		await atomicWrite(this.file("pending.json"), JSON.stringify(entry));
		return entry;
	}
	async finish(entry: AgentHistoryEntry) {
		const index = await this.index();
		if (!index.entries.some((e) => e.applyId === entry.applyId)) {
			if (entry.kind === "apply") {
				index.undo.push(entry.applyId);
				index.redo = [];
			} else if (entry.restoreTo) {
				index.undo = [];
				index.redo = [entry.applyId];
			} else {
				const source = entry.kind === "undo" ? index.undo : index.redo;
				const target = entry.kind === "undo" ? index.redo : index.undo;
				for (const id of entry.targetIds) {
					if (source.pop() !== id)
						throw new Error("HISTORY_CORRUPT: Restore stack does not match journal.");
					target.push(id);
				}
			}
			index.entries.push(entry);
			index.entries.splice(0, Math.max(0, index.entries.length - 50));
			const retained = new Set(index.entries.map((e) => e.applyId));
			index.undo = index.undo.filter((id) => retained.has(id));
			index.redo = index.redo.filter((id) => retained.has(id));
			await atomicWrite(this.file("index.json"), JSON.stringify(index));
		}
		const retainedSnapshots = new Set(
			index.entries.flatMap((e) => [e.snapshotPath, e.afterSnapshotPath]),
		);
		await Promise.all(
			(await fs.readdir(this.directory))
				.filter(
					(name) =>
						/^[a-f0-9-]+\.(before|after)\.json\.gz$/.test(name) && !retainedSnapshots.has(name),
				)
				.map((name) => fs.unlink(this.file(name))),
		);
		await fs.unlink(this.file("pending.json")).catch(() => undefined);
	}
	/** A restore target naming no applyId can name a batch group: entries whose
	 * requestId is the group id or is prefixed with `<group>:` (the batch runner
	 * derives step request ids that way). The group resolves to its oldest entry
	 * on the active stack, so one restore reverts the whole batch and anything
	 * applied after it. */
	private async resolveGroupTarget(stack: string[], to: string | undefined) {
		if (!to) return to;
		const index = await this.index();
		if (index.entries.some((entry) => entry.applyId === to)) return to;
		const groupApplyIds = new Set(
			index.entries
				.filter((entry) => entry.requestId === to || entry.requestId.startsWith(`${to}:`))
				.map((entry) => entry.applyId),
		);
		if (!groupApplyIds.size) return to;
		const onStack = stack.filter((id) => groupApplyIds.has(id));
		if (!onStack.length)
			throw new Error(
				"HISTORY_UNAVAILABLE: Requested entries are not retained or available for this action.",
			);
		return onStack.at(-1);
	}

	async select(
		kind: "undo" | "redo",
		current: ProjectTransactionVersion,
		input: { steps?: number; to?: string; force?: boolean },
	) {
		const index = await this.index();
		const stack = (kind === "undo" ? index.undo : index.redo).slice().reverse();
		const to = await this.resolveGroupTarget(stack, input.to);
		const auditTarget =
			kind === "undo" &&
			to &&
			(!stack.includes(to) || index.entries.find((e) => e.applyId === to)?.kind !== "apply")
				? index.entries.find((e) => e.applyId === to)
				: undefined;
		const steps = auditTarget ? 1 : to ? stack.indexOf(to) + 1 : (input.steps ?? 1);
		if (!Number.isInteger(steps) || steps < 1 || (!auditTarget && steps > stack.length))
			throw new Error(
				"HISTORY_UNAVAILABLE: Requested entries are not retained or available for this action.",
			);
		const latest = index.entries.at(-1);
		if (
			!input.force &&
			(latest?.afterRevision !== current.revision || latest?.afterFileHash !== current.fileHash)
		)
			throw new Error(
				"HISTORY_CONFLICT: Current revision differs from history afterRevision; someone edited in between. Use --force to restore anyway.",
			);
		const targetIds = auditTarget ? [auditTarget.applyId] : stack.slice(0, steps);
		const entries = targetIds.map((id) => {
			const entry = index.entries.find((e) => e.applyId === id);
			if (!entry) throw new Error("HISTORY_CORRUPT: Missing entry.");
			return entry;
		});
		if (!input.force && auditTarget) {
			const later = index.entries.slice(
				index.entries.findIndex((e) => e.applyId === auditTarget.applyId),
			);
			for (let i = 1; i < later.length; i++)
				if (
					later[i].beforeRevision !== later[i - 1].afterRevision ||
					later[i].beforeFileHash !== later[i - 1].afterFileHash
				)
					throw new Error(
						"HISTORY_CONFLICT: An intervening edit separates this checkpoint. Use --force to restore anyway.",
					);
		}
		const restoresBefore = (entry: AgentHistoryEntry) =>
			auditTarget ? true : entry.restoreTo ? kind === "redo" : kind === "undo";
		let cursor = latest?.afterStateRevision ?? "";
		if (!input.force && !auditTarget)
			for (const entry of entries) {
				if (
					cursor !== (restoresBefore(entry) ? entry.afterStateRevision : entry.beforeStateRevision)
				)
					throw new Error(
						"HISTORY_CONFLICT: An intervening edit separates these entries. Use --force to restore anyway.",
					);
				cursor = restoresBefore(entry) ? entry.beforeStateRevision : entry.afterStateRevision;
			}
		const target = entries[entries.length - 1];
		const snapshotPath = restoresBefore(target) ? target.snapshotPath : target.afterSnapshotPath;
		const bytes = await decompress(await fs.readFile(this.file(snapshotPath)), {
			maxOutputLength: 32 * 1024 * 1024,
		});
		return {
			document: documentSchema.parse(JSON.parse(bytes.toString("utf8"))),
			targetIds,
			stateRevision: restoresBefore(target)
				? target.beforeStateRevision
				: target.afterStateRevision,
			intent: {
				kind,
				targetIds,
				...(auditTarget ? { restoreTo: auditTarget.applyId } : {}),
				force: !!input.force,
				planSummary: `${kind} ${targetIds.join(", ")}`,
			} satisfies AgentHistoryIntent,
		};
	}
}

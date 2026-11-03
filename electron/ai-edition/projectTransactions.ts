/** Storage primitives only. Callers must provide exclusive process ownership and
 * migrate every legacy writer before exposing mutations outside the app.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
	type AxcutDocument,
	axcutSchemaVersion,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "../../src/lib/ai-edition/schema";
import { buildReceiptHashes } from "../cli/agentReceiptHashes";
import { type AgentHistoryIntent, AgentHistoryStore } from "./agentHistory";

const FIELD = "_klipptTransactions";
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const importedMediaHashSchema = z
	.object({
		asset_id: z.string().min(1),
		kind: z.string().min(1),
		path: z.string().min(1),
		sha256: digestSchema.nullable(),
		status: z.enum(["hashed", "unreadable"]),
	})
	.strict();
const contentHashesSchema = z
	.object({
		sha256_before: digestSchema,
		sha256_after: digestSchema,
		imported_media: z.array(importedMediaHashSchema).max(64),
	})
	.strict();
const receiptSchema = z
	.object({
		requestId: z.string().min(1).max(256),
		payloadHash: digestSchema,
		operationId: z.string().min(1),
		revision: z.string().min(1),
		changed: z.boolean(),
		// Optional so receipts written before phase 6 still parse.
		contentHashes: contentHashesSchema.optional(),
	})
	.strict();
const tombstoneSchema = receiptSchema.pick({ requestId: true, payloadHash: true });
const MAX_TRANSACTION_UNDO_BYTES = 16 * 1024 * 1024;
const undoRecoverySchema = z
	.object({
		requestId: z.string().min(1).max(256),
		afterRevision: z.string().min(1),
		// Written by whichever build made the commit; a later schema must still open it.
		beforeDocument: z.preprocess(
			(raw) =>
				(raw as { schemaVersion?: unknown } | null)?.schemaVersion === axcutSchemaVersion
					? raw
					: migrateRawDocumentToCurrent(raw),
			documentSchema,
		),
	})
	.strict();
const metadataSchema = z
	.object({
		version: z.literal(1),
		mutationIdentity: z.string().min(1),
		revision: z.string().min(1),
		contentHash: digestSchema,
		receipts: z.array(receiptSchema).max(128),
		tombstones: z.array(tombstoneSchema).max(100_000),
		undoRecovery: undoRecoverySchema.optional(),
	})
	.strict();
export type ProjectTransactionReceipt = z.infer<typeof receiptSchema>;
export interface ProjectTransactionVersion {
	mutationIdentity: string;
	revision: string;
	/** Hash of the exact persisted bytes, before migration or relinking. */
	fileHash: string;
}
export interface ProjectTransactionSnapshot {
	document: AxcutDocument;
	version: ProjectTransactionVersion;
	undoRecovery?: z.infer<typeof undoRecoverySchema>;
}
export class ProjectTransactionError extends Error {
	constructor(
		public readonly code:
			| "CONFLICT"
			| "KEY_REUSED"
			| "RECEIPT_EXPIRED"
			| "CAPACITY"
			| "CORRUPT_METADATA"
			| "IDENTITY_CHANGED"
			| "COMMIT_UNCERTAIN",
		message: string,
	) {
		super(message);
	}
}
function hash(text: string) {
	return createHash("sha256").update(text).digest("hex");
}
/** Reject non-JSON values rather than silently hashing an altered request. */
export function canonicalTransactionPayload(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalTransactionPayload).join(",")}]`;
	if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalTransactionPayload((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	throw new TypeError("Transaction payload must contain only JSON values");
}
export function parseProjectTransactionRecord(
	raw: string,
): ProjectTransactionSnapshot & { metadata: z.infer<typeof metadataSchema> | null } {
	const object: unknown = JSON.parse(raw);
	if (!object || typeof object !== "object" || Array.isArray(object))
		throw new TypeError("Expected project object");
	const { [FIELD]: storedMetadata, ...content } = object as Record<string, unknown>;
	const metadata = storedMetadata === undefined ? null : metadataSchema.parse(storedMetadata);
	if (metadata) {
		const keys = [...metadata.receipts, ...metadata.tombstones].map((item) => item.requestId);
		if (
			metadata.contentHash !== hash(canonicalTransactionPayload(content)) ||
			new Set(keys).size !== keys.length
		) {
			throw new ProjectTransactionError(
				"CORRUPT_METADATA",
				"Project content or receipt identity does not match metadata",
			);
		}
	}
	const document = documentSchema.parse(migrateRawDocumentToCurrent(content));
	if (
		metadata?.undoRecovery &&
		(metadata.undoRecovery.beforeDocument.project.id !== document.project.id ||
			Buffer.byteLength(JSON.stringify(metadata.undoRecovery.beforeDocument)) >
				MAX_TRANSACTION_UNDO_BYTES)
	)
		throw new ProjectTransactionError(
			"CORRUPT_METADATA",
			"Invalid or oversized Undo recovery document",
		);
	const fileHash = hash(raw);
	return {
		document,
		metadata,
		...(metadata?.undoRecovery?.afterRevision === metadata?.revision && metadata?.undoRecovery
			? { undoRecovery: metadata.undoRecovery }
			: {}),
		version: {
			mutationIdentity:
				metadata?.mutationIdentity ?? `legacy-${hash(`${document.project.id}:${fileHash}`)}`,
			revision: metadata?.revision ?? `initial-${fileHash}`,
			fileHash,
		},
	};
}
type TransactionFaultStage = "before-rename" | "after-rename" | "after-directory-sync";
export interface ProjectTransactionOptions {
	receiptLimit?: number;
	/** Never evict used keys. Fail closed when this bound is reached. */
	keyLimit?: number;
	fault?: (stage: TransactionFaultStage) => void | Promise<void>;
}
/** One managed file per instance. Queues are shared by canonical path within this
 * process, not across processes. No GUI history or ownership claim is made here.
 */
export class ProjectTransactionStore {
	private static queues = new Map<string, Promise<unknown>>();
	private readonly filePath: string;
	private readonly receiptLimit: number;
	private readonly keyLimit: number;
	constructor(
		filePath: string,
		private readonly options: ProjectTransactionOptions = {},
	) {
		this.filePath = path.resolve(filePath);
		this.receiptLimit = options.receiptLimit ?? 64;
		this.keyLimit = options.keyLimit ?? 100_000;
		if (
			!Number.isInteger(this.receiptLimit) ||
			this.receiptLimit < 1 ||
			this.receiptLimit > 128 ||
			!Number.isInteger(this.keyLimit) ||
			this.keyLimit < this.receiptLimit ||
			this.keyLimit > 100_000
		)
			throw new RangeError("Invalid transaction retention limits");
	}
	async history() {
		const record = await this.readRecord();
		const store = new AgentHistoryStore(this.filePath);
		await store.recover(record.metadata?.receipts ?? []);
		return store;
	}
	async read(): Promise<ProjectTransactionSnapshot> {
		const { document, version, undoRecovery } = await this.readRecord();
		return { document, version, ...(undoRecovery ? { undoRecovery } : {}) };
	}
	private async readRecord() {
		// Refuse final symlinks. Exclusive ownership must also protect the parent.
		if (!(await fs.lstat(this.filePath)).isFile())
			throw new TypeError("Expected regular managed project file");
		return parseProjectTransactionRecord(await fs.readFile(this.filePath, "utf8"));
	}
	async receipt(requestId: string): Promise<ProjectTransactionReceipt | null> {
		const record = await this.readRecord();
		const receipt = record.metadata?.receipts.find((item) => item.requestId === requestId);
		if (receipt) return receipt;
		if (record.metadata?.tombstones.some((item) => item.requestId === requestId))
			throw new ProjectTransactionError(
				"RECEIPT_EXPIRED",
				"Request already committed; its full receipt expired",
			);
		return null;
	}
	commit(
		request: {
			requestId: string;
			payload: unknown;
			expected: ProjectTransactionVersion;
			recordUndo?: boolean;
			agentHistory?: AgentHistoryIntent;
		},
		transform: (document: AxcutDocument) => AxcutDocument,
	): Promise<ProjectTransactionReceipt> {
		const requestId = z.string().min(1).max(256).parse(request.requestId);
		// Capture request identity before yielding; caller mutation cannot change it.
		const payloadHash = hash(
			canonicalTransactionPayload({
				payload: request.payload,
				recordUndo: request.recordUndo === true,
				...(request.agentHistory ? { agentHistory: request.agentHistory } : {}),
			}),
		);
		const recordUndo = request.recordUndo === true;
		const expected = { ...request.expected };
		const historyIntent = request.agentHistory ? structuredClone(request.agentHistory) : undefined;
		const prior = ProjectTransactionStore.queues.get(this.filePath) ?? Promise.resolve();
		const run = prior
			.catch(() => undefined)
			.then(async () => {
				const base = await this.readRecord();
				const history = new AgentHistoryStore(this.filePath);
				await history.recover(base.metadata?.receipts ?? []);
				const existing = base.metadata?.receipts.find((item) => item.requestId === requestId);
				const expired = base.metadata?.tombstones.find((item) => item.requestId === requestId);
				if (existing || expired) {
					if ((existing ?? expired)?.payloadHash !== payloadHash)
						throw new ProjectTransactionError(
							"KEY_REUSED",
							"Request key was used with different content",
						);
					if (existing) return existing;
					throw new ProjectTransactionError(
						"RECEIPT_EXPIRED",
						"Request already committed; its full receipt expired",
					);
				}
				if (
					expected.revision !== base.version.revision ||
					expected.fileHash !== base.version.fileHash ||
					expected.mutationIdentity !== base.version.mutationIdentity
				)
					throw new ProjectTransactionError(
						"CONFLICT",
						"Expected persisted version is no longer current",
					);
				const receipts = base.metadata?.receipts ?? [];
				const tombstones = base.metadata?.tombstones ?? [];
				if (receipts.length + tombstones.length >= this.keyLimit)
					throw new ProjectTransactionError(
						"CAPACITY",
						"Request-key retention capacity reached; no keys were forgotten",
					);
				const beforeHash = hash(canonicalTransactionPayload(base.document));
				const next = documentSchema.parse(transform(structuredClone(base.document)));
				if (next.project.id !== base.document.project.id)
					throw new ProjectTransactionError(
						"IDENTITY_CHANGED",
						"A transaction cannot change project identity",
					);
				const contentHash = hash(canonicalTransactionPayload(next));
				// Receipt evidence: the exact persisted bytes before, the
				// serialized document after, and hashes of any media this
				// transaction imported. Hashing reports unreadable media instead of
				// failing the commit (see agentReceiptHashes).
				const contentHashes = await buildReceiptHashes(base.document, next, {
					sha256Before: base.version.fileHash,
					sha256After: hash(JSON.stringify(next)),
				});
				const receipt: ProjectTransactionReceipt = {
					requestId,
					payloadHash,
					operationId: randomUUID(),
					revision: randomUUID(),
					changed: contentHash !== beforeHash,
					contentHashes,
				};
				const retained = [...receipts, receipt];
				const removed = retained.splice(0, Math.max(0, retained.length - this.receiptLimit));
				const undoRecovery =
					recordUndo && receipt.changed
						? { requestId, afterRevision: receipt.revision, beforeDocument: base.document }
						: undefined;
				if (
					undoRecovery &&
					Buffer.byteLength(JSON.stringify(undoRecovery.beforeDocument)) >
						MAX_TRANSACTION_UNDO_BYTES
				)
					throw new ProjectTransactionError(
						"CAPACITY",
						"Undo recovery snapshot exceeds 16 MiB; transaction not committed",
					);
				const metadata = metadataSchema.parse({
					...(undoRecovery ? { undoRecovery } : {}),
					version: 1,
					mutationIdentity: base.version.mutationIdentity,
					revision: receipt.revision,
					contentHash,
					receipts: retained,
					tombstones: [
						...tombstones,
						...removed.map(({ requestId, payloadHash }) => ({ requestId, payloadHash })),
					],
				});
				const serialized = JSON.stringify({ ...next, [FIELD]: metadata }, null, 2);
				if (recordUndo && Buffer.byteLength(serialized) > 32 * 1024 * 1024)
					throw new ProjectTransactionError(
						"CAPACITY",
						"Transaction with Undo exceeds the 32 MiB inspection limit",
					);
				const entry = historyIntent
					? await history.prepare(
							base.document,
							next,
							base.version,
							receipt,
							hash(serialized),
							historyIntent,
						)
					: undefined;
				await this.write(serialized);
				if (entry) {
					try {
						await history.finish(entry);
					} catch {
						throw new ProjectTransactionError(
							"COMMIT_UNCERTAIN",
							"Project committed; history journal needs recovery. Query receipt before retrying.",
						);
					}
				}
				return receipt;
			});
		ProjectTransactionStore.queues.set(this.filePath, run);
		void run
			.finally(() => {
				if (ProjectTransactionStore.queues.get(this.filePath) === run)
					ProjectTransactionStore.queues.delete(this.filePath);
			})
			.catch(() => undefined);
		return run;
	}
	private async write(contents: string) {
		const temp = `${this.filePath}.tmp-${randomUUID()}`;
		let renamed = false;
		try {
			const handle = await fs.open(temp, "wx", 0o600);
			try {
				await handle.writeFile(contents, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.options.fault?.("before-rename");
			await fs.rename(temp, this.filePath);
			renamed = true;
			await this.options.fault?.("after-rename");
			// Node 22 FileHandle.sync requests OS persistence; it is not a device
			// power-loss guarantee. Unsupported directory sync fails explicitly.
			// https://nodejs.org/download/release/v22.22.1/docs/api/fs.html#filehandlesync
			const directory = await fs.open(path.dirname(this.filePath), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			await this.options.fault?.("after-directory-sync");
		} catch (error) {
			if (renamed)
				throw new ProjectTransactionError(
					"COMMIT_UNCERTAIN",
					"Snapshot rename succeeded; recover the request receipt before retrying",
				);
			throw error;
		} finally {
			await fs.unlink(temp).catch(() => undefined);
		}
	}
}

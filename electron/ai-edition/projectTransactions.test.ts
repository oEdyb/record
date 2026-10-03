import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	canonicalTransactionPayload,
	ProjectTransactionStore,
	parseProjectTransactionRecord,
} from "./projectTransactions";

describe("project transaction storage (not external writer ownership)", () => {
	let root: string;
	let file: string;
	let store: ProjectTransactionStore;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-transactions-"));
		file = path.join(root, "project.klippt");
		await fs.writeFile(
			file,
			JSON.stringify(createEmptyDocument({ projectId: "p", title: "Original" })),
		);
		store = new ProjectTransactionStore(file);
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	const rename = (title: string) => (doc: ReturnType<typeof createEmptyDocument>) => ({
		...doc,
		project: { ...doc.project, title },
	});
	async function commit(key: string, title: string, target = store) {
		return target.commit(
			{ requestId: key, payload: { title }, expected: (await target.read()).version },
			rename(title),
		);
	}
	it("loads old snapshots deterministically without writing or leaking metadata into document history", async () => {
		const raw = await fs.readFile(file, "utf8");
		expect(await store.read()).toEqual(await new ProjectTransactionStore(file).read());
		expect(await fs.readFile(file, "utf8")).toBe(raw);
		await commit("one", "Edited");
		expect((await store.read()).document).not.toHaveProperty("_klipptTransactions");
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toHaveProperty("_klipptTransactions");
	});
	it("rejects stale concurrent commits across two instances sharing a path", async () => {
		const expected = (await store.read()).version;
		const results = await Promise.allSettled([
			store.commit({ requestId: "a", payload: "a", expected }, rename("A")),
			new ProjectTransactionStore(file).commit(
				{ requestId: "b", payload: "b", expected },
				rename("B"),
			),
		]);
		expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
		expect(results[1]).toMatchObject({ reason: { code: "CONFLICT" } });
		expect((await store.read()).document.project.title).toBe("A");
	});
	it("recovers exact receipt before CAS and does not execute the transform again after restart", async () => {
		const request = {
			requestId: "a",
			payload: { a: 1, b: 2 },
			expected: (await store.read()).version,
		};
		const receipt = await store.commit(request, rename("A"));
		await commit("later", "Later");
		const recovered = await new ProjectTransactionStore(file).commit(
			{ ...request, payload: { b: 2, a: 1 } },
			() => {
				throw new Error("must not execute");
			},
		);
		expect(recovered).toEqual(receipt);
		expect((await store.read()).document.project.title).toBe("Later");
		await expect(
			store.commit({ ...request, payload: "different" }, rename("No")),
		).rejects.toMatchObject({ code: "KEY_REUSED" });
	});
	it("retains used keys after receipt eviction and fails closed at capacity", async () => {
		store = new ProjectTransactionStore(file, { receiptLimit: 1, keyLimit: 2 });
		await commit("a", "A");
		await commit("b", "B");
		await expect(store.receipt("a")).rejects.toMatchObject({ code: "RECEIPT_EXPIRED" });
		await expect(commit("a", "A")).rejects.toMatchObject({ code: "RECEIPT_EXPIRED" });
		await expect(commit("c", "C")).rejects.toMatchObject({ code: "CAPACITY" });
		expect((await store.read()).document.project.title).toBe("B");
	});
	it("detects out-of-band content changes without trusting unchanged metadata revision", async () => {
		await commit("a", "A");
		const record = JSON.parse(await fs.readFile(file, "utf8"));
		record.project.title = "Tampered";
		await fs.writeFile(file, JSON.stringify(record));
		await expect(store.read()).rejects.toMatchObject({ code: "CORRUPT_METADATA" });
	});
	it("detects metadata stripping using the expected persisted version", async () => {
		await commit("a", "A");
		const snapshot = await store.read();
		await fs.writeFile(file, JSON.stringify(snapshot.document));
		await expect(
			store.commit({ requestId: "b", payload: {}, expected: snapshot.version }, rename("B")),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it.each([
		"before-rename",
		"after-rename",
		"after-directory-sync",
	] as const)("recovers old or new state at %s fault", async (stage) => {
		const expected = (await store.read()).version;
		const failing = new ProjectTransactionStore(file, {
			fault: (point) => {
				if (point === stage) throw new Error("injected failure");
			},
		});
		await expect(
			failing.commit({ requestId: "a", payload: "A", expected }, rename("A")),
		).rejects.toThrow();
		const recovered = new ProjectTransactionStore(file);
		expect((await recovered.read()).document.project.title).toBe(
			stage === "before-rename" ? "Original" : "A",
		);
		expect(await recovered.receipt("a")).toEqual(
			stage === "before-rename" ? null : expect.objectContaining({ requestId: "a" }),
		);
		expect((await fs.readdir(root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});
	it("does not poison the queue after a rejected transform or change project identity", async () => {
		const expected = (await store.read()).version;
		await expect(
			store.commit({ requestId: "a", payload: {}, expected }, (doc) => ({
				...doc,
				project: { ...doc.project, id: "other" },
			})),
		).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
		await commit("b", "Good");
		expect((await store.read()).document.project.title).toBe("Good");
	});
	it("recovers one bounded content-only Undo snapshot and drops it when a later commit makes it inapplicable", async () => {
		const before = await store.read();
		const request = {
			requestId: "agent",
			payload: "A",
			expected: before.version,
			recordUndo: true,
		};
		const receipt = await store.commit(request, rename("A"));
		const restarted = new ProjectTransactionStore(file);
		expect((await restarted.read()).undoRecovery).toEqual({
			requestId: "agent",
			afterRevision: receipt.revision,
			beforeDocument: before.document,
		});
		await expect(
			restarted.commit({ ...request, recordUndo: false }, rename("A")),
		).rejects.toMatchObject({ code: "KEY_REUSED" });
		await commit("gui", "GUI", restarted);
		expect((await restarted.read()).undoRecovery).toBeUndefined();
	});
	it("refuses oversized Undo before changing project bytes", async () => {
		const base = await store.read();
		const large = {
			...base.document,
			project: { ...base.document.project, title: "x".repeat(16 * 1024 * 1024) },
		};
		await fs.writeFile(file, JSON.stringify(large));
		const current = await store.read();
		await expect(
			store.commit(
				{ requestId: "large", payload: {}, expected: current.version, recordUndo: true },
				rename("Small"),
			),
		).rejects.toMatchObject({ code: "CAPACITY" });
		expect((await store.read()).version).toEqual(current.version);
	});

	it("validates malformed metadata and non-JSON request values instead of silently stripping them", async () => {
		const raw = JSON.parse(await fs.readFile(file, "utf8"));
		expect(() =>
			parseProjectTransactionRecord(
				JSON.stringify({ ...raw, _klipptTransactions: { version: 99 } }),
			),
		).toThrow();
		expect(() => canonicalTransactionPayload({ x: undefined })).toThrow();
		expect(() => canonicalTransactionPayload({ x: NaN })).toThrow();
	});

	it("receipts carry content hashes: file before, serialized document after, imported media", async () => {
		const before = await store.read();
		const receipt = await store.commit(
			{ requestId: "hash", payload: { title: "Hashed" }, expected: before.version },
			rename("Hashed"),
		);
		expect(receipt.contentHashes?.sha256_before).toBe(before.version.fileHash);
		// sha256_after covers the serialized document (the file minus metadata).
		const fileBytes = await fs.readFile(file, "utf8");
		expect(receipt.contentHashes?.sha256_after).not.toBe(
			createHash("sha256").update(fileBytes).digest("hex"),
		);
		const onDisk = JSON.parse(fileBytes) as Record<string, unknown>;
		delete onDisk._klipptTransactions;
		expect(receipt.contentHashes?.sha256_after).toBe(
			createHash("sha256").update(JSON.stringify(onDisk)).digest("hex"),
		);
		expect(receipt.contentHashes?.imported_media).toEqual([]);
		// The stored receipt round-trips through the metadata schema.
		const reread = await new ProjectTransactionStore(file).receipt("hash");
		expect(reread?.contentHashes).toEqual(receipt.contentHashes);
	});

	it("hashes media the transaction imported and reports unreadable paths", async () => {
		const media = path.join(root, "imported.wav");
		await fs.writeFile(media, "audio-bytes");
		const before = await store.read();
		const addAsset = (doc: ReturnType<typeof createEmptyDocument>) => ({
			...doc,
			assets: [
				...doc.assets,
				{
					id: "asset-new",
					kind: "video" as const,
					label: "New",
					originalPath: media,
					durationSec: 1,
					cameraTrack: null,
				},
				{
					id: "asset-gone",
					kind: "video" as const,
					label: "Gone",
					originalPath: path.join(root, "missing.mp4"),
					durationSec: 1,
					cameraTrack: null,
				},
			],
		});
		const receipt = await store.commit(
			{ requestId: "import", payload: {}, expected: before.version },
			addAsset,
		);
		expect(receipt.contentHashes?.imported_media).toEqual([
			{
				asset_id: "asset-new",
				kind: "video",
				path: media,
				sha256: createHash("sha256").update("audio-bytes").digest("hex"),
				status: "hashed",
			},
			{
				asset_id: "asset-gone",
				kind: "video",
				path: path.join(root, "missing.mp4"),
				sha256: null,
				status: "unreadable",
			},
		]);
	});

	it("tolerates receipts without content hashes and history recovery with them", async () => {
		// History recovery reads receipts carrying contentHashes.
		await store.commit(
			{
				requestId: "journaled",
				payload: {},
				expected: (await store.read()).version,
				recordUndo: true,
				agentHistory: {
					kind: "apply",
					targetIds: [],
					force: false,
					planSummary: "1 operations: set-layout",
				},
			},
			rename("Journaled"),
		);
		const history = await store.history();
		expect((await history.list()).map((entry) => entry.requestId)).toEqual(["journaled"]);

		// Receipts written before phase 6 (no contentHashes) still parse.
		const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as {
			_klipptTransactions: { receipts: Record<string, unknown>[] };
		};
		for (const receipt of onDisk._klipptTransactions.receipts) delete receipt.contentHashes;
		await fs.writeFile(file, JSON.stringify(onDisk));
		const restarted = new ProjectTransactionStore(file);
		const receipt = await restarted.receipt("journaled");
		expect(receipt).toMatchObject({ requestId: "journaled" });
		expect(receipt?.contentHashes).toBeUndefined();
	});
});

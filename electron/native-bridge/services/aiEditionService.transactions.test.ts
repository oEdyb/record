import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentService } from "../../ai-edition/document-service";
import { MediaAccessRegistry } from "../../media/mediaAccessRegistry";
import { AiEditionService, type AiEditionServiceOptions } from "./aiEditionService";

describe("native bridge transaction service", () => {
	let root: string;
	let documents: DocumentService;
	let service: AiEditionService;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-bridge-transactions-"));
		documents = new DocumentService(root, root);
		service = new AiEditionService({
			documents,
			llmConfig: () => {
				throw new Error("No LLM needed");
			},
		} as unknown as AiEditionServiceOptions);
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	it("resolves persisted audio paths without granting new access on reopen", async () => {
		const original = await documents.createProject("Audio");
		await documents.saveProject({
			...original,
			audioAssets: [
				{ id: "music", label: "Music", originalPath: "/user/music.wav", durationSec: 3 },
			],
		});
		const resolveMediaPath = vi.fn(async () => "/user/music.wav");
		const reader = new AiEditionService({
			documents,
			resolveMediaPath,
		} as unknown as AiEditionServiceOptions);
		expect((await reader.get(original.project.id)).success).toBe(true);
		expect(resolveMediaPath).toHaveBeenCalledWith("/user/music.wav");
	});

	it("imported JSON cannot create outside-media grants, while a picker grant survives reopen", async () => {
		const source = path.join(root, "private.wav");
		await fs.writeFile(source, "private media");
		const original = await documents.createProject("Untrusted copy");
		const imported = await documents.importProject({
			...original,
			audioAssets: [{ id: "private", label: "Private", originalPath: source, durationSec: 3 }],
		});
		const grantFile = path.join(root, "media-access-grants.json");
		let grants = new MediaAccessRegistry(grantFile);
		const resolved: Array<string | null> = [];
		const reader = new AiEditionService({
			documents,
			resolveMediaPath: async (file: string) => {
				const canonical = await fs.realpath(file);
				const result = grants.hasCanonicalPath(canonical) ? canonical : null;
				resolved.push(result);
				return result;
			},
		} as unknown as AiEditionServiceOptions);
		expect((await reader.get(imported.project.id)).success).toBe(true);
		expect(resolved).toEqual([null]);
		expect(grants.hasCanonicalPath(await fs.realpath(source))).toBe(false);
		await grants.grantSelectedFile(source);
		grants = new MediaAccessRegistry(grantFile);
		await reader.get(imported.project.id);
		expect(resolved.at(-1)).toBe(await fs.realpath(source));
	});

	it("commits an explicit replacement and recovers the receipt without resetting a later revision", async () => {
		const original = await documents.createProject("Original");
		const first = await service.snapshot(original.project.id);
		const guard = { requestId: "a", expected: first.version! };
		const edited = { ...original, project: { ...original.project, title: "Edited" } };
		const result = await service.commit(original.project.id, edited, guard);
		expect(result).toMatchObject({
			success: true,
			snapshotMatchesReceipt: true,
			document: { project: { title: "Edited" } },
		});
		const later = await service.commit(original.project.id, original, {
			requestId: "b",
			expected: result.version!,
		});
		const retry = await service.commit(original.project.id, edited, guard);
		expect(retry).toMatchObject({
			success: true,
			receipt: result.receipt,
			snapshotMatchesReceipt: false,
			version: later.version,
		});
		expect(await service.receipt(original.project.id, "a")).toEqual({
			success: true,
			receipt: result.receipt,
		});
	});
	it("rejects stale writes and request-key reuse with structured errors", async () => {
		const original = await documents.createProject("Original");
		const first = await service.snapshot(original.project.id);
		const guard = { requestId: "a", expected: first.version! };
		await service.commit(original.project.id, original, guard);
		expect(
			await service.commit(original.project.id, original, { ...guard, requestId: "b" }),
		).toMatchObject({ success: false, errorCode: "CONFLICT" });
		expect(
			await service.commit(
				original.project.id,
				{ ...original, project: { ...original.project, title: "Different" } },
				guard,
			),
		).toMatchObject({ success: false, errorCode: "KEY_REUSED" });
	});
	it("keeps successful receipt if post-commit snapshot retrieval fails", async () => {
		const original = await documents.createProject("Original");
		const snapshot = await service.snapshot(original.project.id);
		vi.spyOn(documents, "getTransactionSnapshot").mockRejectedValueOnce(
			new Error("read unavailable"),
		);
		const result = await service.commit(original.project.id, original, {
			requestId: "a",
			expected: snapshot.version!,
		});
		expect(result).toMatchObject({
			success: true,
			errorCode: "SNAPSHOT_UNAVAILABLE",
			receipt: { requestId: "a" },
		});
		expect(result.document).toBeUndefined();
		expect(await service.receipt(original.project.id, "a")).toMatchObject({
			success: true,
			receipt: result.receipt,
		});
	});
	it("validates guards and replacement identity while leaving the legacy endpoint compatible before adoption", async () => {
		const original = await documents.createProject("Original");
		expect(await service.save(original)).toMatchObject({ success: true });
		const snapshot = await service.snapshot(original.project.id);
		const guard = { requestId: "a", expected: snapshot.version! };
		expect(await service.commit("wrong", original, guard)).toMatchObject({
			success: false,
			errorCode: "IDENTITY_CHANGED",
		});
		expect(
			await service.commit(original.project.id, original, {
				...guard,
				expected: { ...guard.expected, fileHash: "bad" },
			}),
		).toMatchObject({ success: false, errorCode: "INVALID_INPUT" });
		await service.commit(original.project.id, original, guard);
		expect(await service.save(original)).toMatchObject({ success: false });
	});
});

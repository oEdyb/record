import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentService } from "./document-service";

const migrationCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/lib/ai-edition/schema", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/ai-edition/schema")>();
	return {
		...actual,
		migrateRawDocumentToCurrent: (value: unknown) => {
			migrationCalls.count++;
			return actual.migrateRawDocumentToCurrent(value);
		},
	};
});

describe("DocumentService project opening", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-project-open-test-"));
		migrationCalls.count = 0;
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	it("migrates once while preserving transaction identity and undo recovery", async () => {
		const service = new DocumentService(directory, directory);
		const original = await service.createProject("Original");
		const snapshot = await service.getTransactionSnapshot(original.project.id);
		const receipt = await service.commitTransaction(
			original.project.id,
			{
				requestId: "edit-title",
				payload: { title: "Edited" },
				expected: snapshot.version,
				recordUndo: true,
			},
			(document) => ({
				...document,
				project: { ...document.project, title: "Edited" },
			}),
		);
		migrationCalls.count = 0;

		const reopened = await new DocumentService(directory, directory).getProjectView(
			original.project.id,
		);

		expect(migrationCalls.count).toBe(1);
		expect(reopened.document.project.title).toBe("Edited");
		expect(reopened.transactionVersion).toMatchObject({
			mutationIdentity: snapshot.version.mutationIdentity,
			revision: receipt.revision,
		});
		expect(reopened.undoRecovery?.beforeDocument.project.title).toBe("Original");
	});
});

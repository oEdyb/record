// @vitest-environment jsdom
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiEditionWriteGuard } from "@/native/contracts";
import { DocumentService } from "../../../../electron/ai-edition/document-service";
import {
	ProjectTransactionError,
	ProjectTransactionStore,
} from "../../../../electron/ai-edition/projectTransactions";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { projectRequest } from "./projectLifecycle";
import {
	applyExternalProjectTransaction,
	resolveLocalTransactionConflict,
	useProjectStore,
} from "./projectStore";
import { seedProjectState } from "./projectStore.testUtils";
import { undo } from "./undo";

const bridge = vi.hoisted(() => ({
	get: vi.fn(),
	getLatest: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	snapshot: vi.fn(),
	commit: vi.fn(),
	receipt: vi.fn(),
	importProject: vi.fn(),
}));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const version = {
	mutationIdentity: "review-b-identity",
	revision: "one",
	fileHash: "a".repeat(64),
};
const base = createEmptyDocument({ projectId: "review-b-project", title: "Base" });
function committed(document: AxcutDocument, requestId: string, revision = "two") {
	return {
		success: true,
		document,
		version: { ...version, revision },
		snapshotMatchesReceipt: true,
		receipt: { requestId, revision, payloadHash: "b".repeat(64), operationId: "op", changed: true },
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}
const outputRoot = path.join(
	process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
	"klippt-work",
	"project-lifecycle-tests",
);
const testRoots = new Set<string>();
afterEach(async () => {
	for (const root of testRoots) await fs.rm(root, { recursive: true, force: true });
	testRoots.clear();
});
async function privateRoot(prefix: string) {
	await fs.mkdir(outputRoot, { recursive: true });
	const root = await fs.mkdtemp(path.join(outputRoot, prefix));
	testRoots.add(root);
	return root;
}
async function makeDisk() {
	const root = await privateRoot("durable-");
	const file = path.join(root, "project.klippt");
	await fs.writeFile(file, JSON.stringify(base));
	return { root, file, disk: new ProjectTransactionStore(file) };
}
async function diskReply(
	disk: ProjectTransactionStore,
	document: AxcutDocument,
	guard: AiEditionWriteGuard,
) {
	try {
		const receipt = await disk.commit({ ...guard, payload: document }, () => document);
		const snapshot = await disk.read();
		return {
			success: true,
			...snapshot,
			receipt,
			snapshotMatchesReceipt: snapshot.version.revision === receipt.revision,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			errorCode: error instanceof ProjectTransactionError ? error.code : "EXECUTION_FAILED",
		};
	}
}
beforeEach(() => {
	seedProjectState({ transactionBusy: false, transactionSyncPending: false });
	useProjectStore.getState().clear();
	Object.values(bridge).forEach((mock) => mock.mockReset());
	window.localStorage.clear();
	bridge.save.mockImplementation(async (document) => ({ success: true, document }));
	seedProjectState({
		projectId: base.project.id,
		document: base,
		status: "ready",
		revision: 1,
		transactionVersion: version,
		dirty: false,
		error: null,
	});
});

it("rejects a queued candidate before a blocked structural rebase can create uncertainty", async () => {
	const { file, disk } = await makeDisk();
	seedProjectState({ transactionVersion: (await disk.read()).version });
	const firstReply = deferred<void>();
	bridge.commit.mockImplementationOnce(async (_id, document, guard) => {
		await firstReply.promise;
		return diskReply(disk, document, guard);
	});
	const uncertain = new ProjectTransactionStore(file, {
		fault: (stage) => {
			if (stage === "after-directory-sync") throw new Error("third commit connection lost");
		},
	});
	bridge.commit.mockImplementationOnce(async (_id, document, guard) =>
		diskReply(uncertain, document, guard),
	);
	const firstDoc: AxcutDocument = {
		...base,
		assets: [
			{ id: "a", kind: "video", label: "A", originalPath: "/review/a.mp4", cameraTrack: null },
		],
	};
	const secondDoc: AxcutDocument = {
		...base,
		assets: [
			{ id: "b", kind: "video", label: "B", originalPath: "/review/b.mp4", cameraTrack: null },
		],
	};
	const thirdDoc = { ...base, project: { ...base.project, title: "Third" } };
	const first = useProjectStore.getState().saveDocument(firstDoc);
	const second = useProjectStore.getState().saveDocument(secondDoc);
	const third = useProjectStore.getState().saveDocument(thirdDoc);
	const outcomes = Promise.allSettled([first, second, third]);
	useProjectStore.getState().setDocumentLive(thirdDoc);
	await vi.waitFor(() => expect(bridge.commit).toHaveBeenCalledTimes(1));
	firstReply.resolve(undefined);
	await outcomes;
	const state = useProjectStore.getState();
	const pending = projectRequest(state.lifecycle);
	const persisted = await disk.read();
	const sentGuard = bridge.commit.mock.calls[1]?.[2];
	const durableReceipt = sentGuard ? await disk.receipt(sentGuard.requestId) : null;
	console.log(
		"REVIEW_B_QUEUE",
		JSON.stringify({
			durableAssets: persisted.document.assets.map((asset) => asset.id),
			durableTitle: persisted.document.project.title,
			durableReceiptPresent: durableReceipt !== null,
			calls: bridge.commit.mock.calls.length,
			secondSentAssets: bridge.commit.mock.calls[1]?.[1].assets.map(
				(asset: { id: string }) => asset.id,
			),
			secondSentTitle: bridge.commit.mock.calls[1]?.[1].project.title,
			pending,
			editing: state.lifecycle.editing.kind,
			syncPending: state.transactionSyncPending,
		}),
	);
	bridge.receipt.mockResolvedValue({ success: false, error: "receipt offline" });
	bridge.importProject.mockImplementation(async (document: AxcutDocument) => ({
		success: true,
		document: { ...document, project: { ...document.project, id: "review-b-copy" } },
	}));
	bridge.get.mockImplementation(async () => ({
		success: true,
		document: {
			...thirdDoc,
			project: { ...thirdDoc.project, id: "review-b-copy" },
		},
	}));
	const recovery = await Promise.allSettled([resolveLocalTransactionConflict("save-copy")]);
	console.log(
		"REVIEW_B_QUEUE_RECOVERY",
		JSON.stringify({
			receiptCalls: bridge.receipt.mock.calls.length,
			importCalls: bridge.importProject.mock.calls.length,
			copiedAssets: bridge.importProject.mock.calls[0]?.[0].assets.map(
				(asset: { id: string }) => asset.id,
			),
			recovery: recovery.map((outcome) => outcome.status),
		}),
	);
	expect(bridge.commit).toHaveBeenCalledTimes(1);
});

it("rejects another external save using the active request id without its owner", async () => {
	const { disk } = await makeDisk();
	const diskVersion = (await disk.read()).version;
	seedProjectState({ transactionVersion: diskVersion });
	const reply = deferred<void>();
	bridge.commit.mockImplementationOnce(async (_id, document, guard) => {
		await reply.promise;
		return diskReply(disk, document, guard);
	});
	bridge.commit.mockImplementation(async (_id, document, guard) =>
		diskReply(disk, document, guard),
	);
	const edited = { ...base, project: { ...base.project, title: "External" } };
	const guard: AiEditionWriteGuard = { requestId: "review-b-external", expected: diskVersion };
	const external = applyExternalProjectTransaction(base.project.id, edited, guard);
	const duplicate = Reflect.apply(useProjectStore.getState().saveDocumentAsEdit, undefined, [
		edited,
		undefined,
		undefined,
		undefined,
		{ ...guard, recordUndo: true },
	]);
	const outcomes = Promise.allSettled([external, duplicate]);
	await vi.waitFor(() => expect(bridge.commit).toHaveBeenCalledTimes(1));
	reply.resolve(undefined);
	const results = await outcomes;
	const undoAvailable = undo();
	console.log(
		"REVIEW_B_EXTERNAL",
		JSON.stringify({
			commitCalls: bridge.commit.mock.calls.length,
			outcomes: results.map((outcome) =>
				outcome.status === "rejected"
					? { status: outcome.status, code: outcome.reason.code }
					: { status: outcome.status, value: outcome.value },
			),
			editing: useProjectStore.getState().lifecycle.editing.kind,
			durableTitle: (await disk.read()).document.project.title,
			undoAvailable,
		}),
	);
	expect(bridge.commit).toHaveBeenCalledTimes(1);
	expect(results[1]).toEqual({ status: "fulfilled", value: false });
	expect(results[0].status).toBe("fulfilled");
	expect(undoAvailable).toBe(true);
});

it("exits loading when a save supersedes an in-flight refresh", async () => {
	const loadReply = deferred<{
		success: boolean;
		document: AxcutDocument;
		transactionVersion: typeof version;
	}>();
	bridge.get.mockImplementationOnce(() => loadReply.promise);
	bridge.commit.mockImplementation(async (_id, document, guard) =>
		committed(document, guard.requestId),
	);
	const loading = useProjectStore.getState().refresh();
	const edited = { ...base, project: { ...base.project, title: "Newer gesture" } };
	useProjectStore.getState().setDocumentLive(edited);
	await useProjectStore.getState().saveDocument(edited);
	loadReply.resolve({ success: true, document: base, transactionVersion: version });
	await loading;
	console.log(
		"REVIEW_B_REFRESH",
		JSON.stringify({
			status: useProjectStore.getState().status,
			title: useProjectStore.getState().document?.project.title,
			dirty: useProjectStore.getState().dirty,
		}),
	);
	expect(useProjectStore.getState().status).toBe("ready");
	expect(useProjectStore.getState().document?.project.title).toBe("Newer gesture");
});

it("retains the exact uncertain request and imported copy across a failed recovery load", async () => {
	const edited = { ...base, project: { ...base.project, title: "Uncertain" } };
	bridge.commit.mockRejectedValueOnce(new Error("lost connection"));
	await expect(useProjectStore.getState().saveDocumentAsEdit(edited)).rejects.toThrow(
		"lost connection",
	);
	const pending = projectRequest(useProjectStore.getState().lifecycle);
	expect(pending?.kind).toBe("local");
	bridge.receipt.mockResolvedValue({ success: true, receipt: null });
	bridge.snapshot.mockResolvedValue({ success: true, document: base, version });
	const copied = { ...edited, project: { ...edited.project, id: "review-b-copy" } };
	bridge.importProject.mockResolvedValue({ success: true, document: copied });
	bridge.get.mockRejectedValueOnce(new Error("copy load failed"));
	await expect(resolveLocalTransactionConflict("save-copy")).rejects.toThrow("copy load failed");
	expect(projectRequest(useProjectStore.getState().lifecycle)).toBe(pending);
	bridge.get.mockResolvedValueOnce({ success: true, document: copied });
	await resolveLocalTransactionConflict("save-copy");
	expect(bridge.importProject).toHaveBeenCalledTimes(1);
	expect(bridge.receipt).toHaveBeenCalledTimes(2);
	expect(useProjectStore.getState().document?.project.id).toBe("review-b-copy");
});

it.each([
	"before-rename",
	"after-rename",
	"after-directory-sync",
] as const)("write stage keeps receipt recovery correct at %s", async (stage) => {
	const { file, disk } = await makeDisk();
	const expected = (await disk.read()).version;
	const failing = new ProjectTransactionStore(file, {
		fault: (point) => {
			if (point === stage) throw new Error(`fault ${stage}`);
		},
	});
	const edited = { ...base, project: { ...base.project, title: "Native durable edit" } };
	const result = await diskReply(failing, edited, { expected, requestId: `reviewB-${stage}` });
	expect(result.success).toBe(false);
	const recovered = await disk.read();
	const receipt = await disk.receipt(`reviewB-${stage}`);
	expect(recovered.document.project.title).toBe(
		stage === "before-rename" ? "Base" : "Native durable edit",
	);
	expect(Boolean(receipt)).toBe(stage !== "before-rename");
	if (stage !== "before-rename") expect(result).toMatchObject({ errorCode: "COMMIT_UNCERTAIN" });
});

it("concurrent legacy migration preserves the original, durable receipt, and Undo", async () => {
	const root = await privateRoot("migration-");
	const legacy = path.join(root, `${base.project.id}.openscreen`);
	await fs.writeFile(legacy, JSON.stringify(base));
	const disk = new ProjectTransactionStore(legacy);
	const edited = { ...base, project: { ...base.project, title: "Legacy committed edit" } };
	const expected = (await disk.read()).version;
	const receipt = await disk.commit(
		{ expected, requestId: "reviewB-migrate", payload: edited, recordUndo: true },
		() => edited,
	);
	const original = await fs.readFile(legacy, "utf8");
	const service = new DocumentService(root, path.join(root, "media"));
	await Promise.all([service.ensureProjectsDir(), service.ensureProjectsDir()]);
	expect(await fs.readFile(legacy, "utf8")).toBe(original);
	expect(await fs.readFile(path.join(root, `${base.project.id}.klippt`), "utf8")).toBe(original);
	const view = await service.getProjectView(base.project.id);
	expect(view.document.project.title).toBe("Legacy committed edit");
	expect(view.undoRecovery?.beforeDocument.project.title).toBe("Base");
	expect(await service.getTransactionReceipt(base.project.id, "reviewB-migrate")).toEqual(receipt);
});

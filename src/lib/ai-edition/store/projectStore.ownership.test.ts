// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { type AxcutDocument, assetSchema, createEmptyDocument } from "../schema";

const bridge = vi.hoisted(() => ({
	get: vi.fn(),
	getLatest: vi.fn(),
	snapshot: vi.fn(),
	commit: vi.fn(),
	receipt: vi.fn(),
	importProject: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	prepareAsset: vi.fn(),
	removeAsset: vi.fn(),
}));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const version = { mutationIdentity: "review-a", revision: "one", fileHash: "a".repeat(64) };
const laterVersion = { ...version, revision: "two", fileHash: "b".repeat(64) };
function committed(document: AxcutDocument, requestId: string, revision = "two") {
	return {
		success: true,
		document,
		version: { ...version, revision },
		snapshotMatchesReceipt: true,
		receipt: { requestId, revision, payloadHash: "c".repeat(64), operationId: "op", changed: true },
	};
}
let mod: typeof import("./projectStore");
const base = createEmptyDocument({ projectId: "review-a-project", title: "Base" });
async function open(document = base, transactionVersion?: typeof version) {
	bridge.get.mockResolvedValueOnce({ success: true, document, transactionVersion });
	await mod.useProjectStore.getState().loadProject(document.project.id);
}
beforeEach(async () => {
	vi.resetModules();
	for (const mock of Object.values(bridge)) mock.mockReset();
	window.localStorage.clear();
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			findRecordingCamera: vi
				.fn()
				.mockResolvedValue({ success: true, webcamVideoPath: "/review-a/camera.mp4" }),
		},
	});
	bridge.save.mockImplementation(async (document: AxcutDocument) => ({ success: true, document }));
	mod = await import("./projectStore");
});

it("camera autosave completion must not publish an asset into a newer opening", async () => {
	await open();
	const asset = assetSchema.parse({
		id: "asset-a",
		kind: "video",
		label: "A",
		originalPath: "/review-a/a.mp4",
	});
	bridge.addAsset.mockResolvedValueOnce({ document: { ...base, assets: [asset] } });
	const save = deferred<{ success: boolean; document: AxcutDocument }>();
	bridge.save.mockReturnValueOnce(save.promise);
	const importing = mod.useProjectStore.getState().addAsset(asset.originalPath);
	await vi.waitFor(() => expect(bridge.save).toHaveBeenCalledOnce());
	const newer = { ...base, project: { ...base.project, id: "review-a-newer", title: "Newer" } };
	await open(newer);
	const linked = bridge.save.mock.calls[0][0] as AxcutDocument;
	save.resolve({ success: true, document: linked });
	await importing;
	const state = mod.useProjectStore.getState();
	console.log(
		"REVIEW_A_ASSET",
		JSON.stringify({
			projectId: state.projectId,
			documentId: state.document?.project.id,
			dirty: state.dirty,
		}),
	);
	expect(state.document?.project.id).toBe(newer.project.id);
});

it("activation response must not replace the CAS version of a newer identical opening", async () => {
	await open();
	const before = mod.useProjectStore.getState();
	const snapshot = deferred<{
		success: boolean;
		document: AxcutDocument;
		version: typeof version;
	}>();
	bridge.snapshot.mockReturnValueOnce(snapshot.promise);
	const activation = mod.activateProjectTransactions(base.project.id);
	mod.useProjectStore.getState().clear();
	await open(base, laterVersion);
	const reopened = mod.useProjectStore.getState();
	expect(reopened.revision).toBe(before.revision);
	expect(reopened.lifecycle.epoch).not.toBe(before.lifecycle.epoch);
	snapshot.resolve({ success: true, document: base, version });
	const outcome = await activation.then(
		() => "accepted",
		(error: Error) => error.message,
	);
	const state = mod.useProjectStore.getState();
	console.log(
		"REVIEW_A_ACTIVATION",
		JSON.stringify({
			outcome,
			beforeEpoch: before.lifecycle.epoch,
			reopenedEpoch: reopened.lifecycle.epoch,
			expectedVersion: laterVersion.revision,
			actualVersion: state.transactionVersion?.revision,
		}),
	);
	expect(state.transactionVersion).toEqual(laterVersion);
});

it("queued writes must stop when a structural conflict rejects local-request", async () => {
	await open(base, version);
	const firstDoc = {
		...base,
		assets: [
			assetSchema.parse({ id: "a", kind: "video", label: "A", originalPath: "/review-a/a.mp4" }),
		],
	};
	const secondDoc = {
		...base,
		assets: [
			assetSchema.parse({ id: "b", kind: "video", label: "B", originalPath: "/review-a/b.mp4" }),
		],
	};
	const thirdDoc = { ...base, project: { ...base.project, title: "Third queued save" } };
	const firstCommit = deferred<ReturnType<typeof committed>>();
	bridge.commit.mockReturnValueOnce(firstCommit.promise);
	bridge.commit.mockImplementation(
		async (_id: string, document: AxcutDocument, guard: { requestId: string }) =>
			committed(document, guard.requestId, "three"),
	);
	const first = mod.useProjectStore.getState().saveDocument(firstDoc);
	const second = mod.useProjectStore.getState().saveDocument(secondDoc);
	const third = mod.useProjectStore.getState().saveDocument(thirdDoc);
	const outcomes = Promise.allSettled([first, second, third]);
	const live = { ...base, project: { ...base.project, title: "Newest live gesture" } };
	mod.useProjectStore.getState().setDocumentLive(live);
	await vi.waitFor(() => expect(bridge.commit).toHaveBeenCalledOnce());
	firstCommit.resolve(committed(firstDoc, bridge.commit.mock.calls[0][2].requestId));
	await outcomes;
	const state = mod.useProjectStore.getState();
	console.log(
		"REVIEW_A_QUEUE",
		JSON.stringify({
			commitCalls: bridge.commit.mock.calls.length,
			editing: state.lifecycle.editing.kind,
			title: state.document?.project.title,
			request:
				state.lifecycle.editing.kind === "blocked" ? state.lifecycle.editing.reason.request : null,
		}),
	);
	expect(bridge.commit).toHaveBeenCalledTimes(1);
});

it("stale create must not save defaults over a newer opening of its project", async () => {
	const create = deferred<{ success: boolean; document: AxcutDocument }>();
	bridge.create.mockReturnValueOnce(create.promise);
	bridge.commit.mockImplementation(
		async (_id: string, document: AxcutDocument, guard: { requestId: string }) =>
			committed(document, guard.requestId, "three"),
	);
	const creating = mod.useProjectStore.getState().createProject("Base");
	const newer = { ...base, project: { ...base.project, title: "Newer saved edit" } };
	await open(newer, laterVersion);
	create.resolve({ success: true, document: base });
	await creating;
	const state = mod.useProjectStore.getState();
	console.log(
		"REVIEW_A_CREATE",
		JSON.stringify({
			commitCalls: bridge.commit.mock.calls.length,
			committedTitle: bridge.commit.mock.calls[0]?.[1].project.title,
			expectedRevisionSent: bridge.commit.mock.calls[0]?.[2].expected.revision,
			editorTitle: state.document?.project.title,
			editorVersion: state.transactionVersion?.revision,
		}),
	);
	expect(bridge.commit.mock.calls.length).toBe(0);
});

it("a rejected queued request cannot create a new uncertain write", async () => {
	await open(base, version);
	const firstDoc = {
		...base,
		assets: [
			assetSchema.parse({ id: "a", kind: "video", label: "A", originalPath: "/review-a/a.mp4" }),
		],
	};
	const secondDoc = {
		...base,
		assets: [
			assetSchema.parse({ id: "b", kind: "video", label: "B", originalPath: "/review-a/b.mp4" }),
		],
	};
	const thirdDoc = { ...base, project: { ...base.project, title: "Third uncertain candidate" } };
	const firstCommit = deferred<ReturnType<typeof committed>>();
	bridge.commit.mockReturnValueOnce(firstCommit.promise);
	bridge.commit.mockRejectedValueOnce(new Error("Lost commit response"));
	const first = mod.useProjectStore.getState().saveDocument(firstDoc);
	const second = mod.useProjectStore.getState().saveDocument(secondDoc);
	const third = mod.useProjectStore.getState().saveDocument(thirdDoc);
	const outcomes = Promise.allSettled([first, second, third]);
	mod.useProjectStore
		.getState()
		.setDocumentLive({ ...base, project: { ...base.project, title: "Newest live gesture" } });
	await vi.waitFor(() => expect(bridge.commit).toHaveBeenCalledOnce());
	firstCommit.resolve(committed(firstDoc, bridge.commit.mock.calls[0][2].requestId));
	await outcomes;
	const beforeRecovery = mod.useProjectStore.getState().lifecycle.editing;
	const retainedRequest = beforeRecovery.kind === "blocked" ? beforeRecovery.reason.request : null;
	bridge.get.mockResolvedValueOnce({
		success: true,
		document: firstDoc,
		transactionVersion: laterVersion,
	});
	const recovery = await mod.resolveLocalTransactionConflict("reload");
	const state = mod.useProjectStore.getState();
	console.log(
		"REVIEW_A_UNCERTAINTY",
		JSON.stringify({
			commitCalls: bridge.commit.mock.calls.length,
			retainedRequest,
			receiptCalls: bridge.receipt.mock.calls.length,
			recovery: recovery.strategy,
			editing: state.lifecycle.editing.kind,
		}),
	);
	expect(bridge.commit).toHaveBeenCalledOnce();
	expect(bridge.receipt).not.toHaveBeenCalled();
});

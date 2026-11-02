// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "../schema";
import { saveEditorDefaultPreferences } from "./editingPreferences";
import { DEFAULT_EDITOR_SETTINGS, getEditorSettings } from "./editorSettings";
import {
	activateProjectTransactions,
	applyExternalProjectTransaction,
	getProjectMutationGeneration,
	reconcileProjectTransactions,
	resolveLocalTransactionConflict,
	useProjectStore,
	waitForProjectMutations,
} from "./projectStore";
import { redo, undo } from "./undo";

const bridgeMocks = vi.hoisted(() => ({
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
	listProjects: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			getLatest: bridgeMocks.getLatest,
			snapshot: bridgeMocks.snapshot,
			commit: bridgeMocks.commit,
			receipt: bridgeMocks.receipt,
			importProject: bridgeMocks.importProject,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			prepareAsset: bridgeMocks.prepareAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: toastMocks.error },
}));

const sampleDoc = {
	// ponytail: the bridge contract after the migration hoist is current — every
	// load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a current-schema
	// validator. Test fixtures model the post-hoist contract.
	// `as const` and not a bare number: the document type pins this field to a
	// literal, and an unannotated object literal widens it to `number` — so
	// every `document: sampleDoc` below fails to type-check for a fixture that
	// is, in fact, exactly right.
	schemaVersion: 11 as const,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
	},
	assets: [],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
};

describe("useProjectStore", () => {
	beforeEach(() => {
		useProjectStore.setState({ transactionBusy: false, transactionSyncPending: false });
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) {
			mock.mockReset();
		}
		window.localStorage.clear();
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		toastMocks.error.mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI = { findRecordingCamera: vi.fn() };
	});

	afterEach(() => {
		vi.clearAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		delete (window as any).electronAPI;
	});

	const version = { mutationIdentity: "identity", revision: "one", fileHash: "a".repeat(64) };
	async function activate() {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			status: "ready",
			dirty: false,
		});
		bridgeMocks.snapshot.mockResolvedValue({ success: true, document: sampleDoc, version });
		await activateProjectTransactions(sampleDoc.project.id);
	}
	function committed(document: AxcutDocument, requestId: string, revision = "two") {
		return {
			success: true,
			document,
			version: { ...version, revision },
			snapshotMatchesReceipt: true,
			receipt: {
				requestId,
				revision,
				payloadHash: "b".repeat(64),
				operationId: "op",
				changed: true,
			},
		};
	}
	it("activates only a clean matching saved snapshot and rejects dirty or changed live content", async () => {
		await activate();
		expect(useProjectStore.getState().transactionVersion).toEqual(version);
		useProjectStore
			.getState()
			.setDocumentLive({ ...sampleDoc, project: { ...sampleDoc.project, title: "Unsaved" } });
		await expect(activateProjectTransactions(sampleDoc.project.id)).rejects.toMatchObject({
			code: "EDITOR_BUSY",
		});
		useProjectStore.setState({ dirty: false });
		await expect(activateProjectTransactions(sampleDoc.project.id)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});
	it("commits one external edit, blocks live gestures and Undo during the barrier, and creates one normal Undo step", async () => {
		await activate();
		let finish!: (value: ReturnType<typeof committed>) => void;
		bridgeMocks.commit.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const edited = { ...sampleDoc, project: { ...sampleDoc.project, title: "Edited" } };
		const applying = applyExternalProjectTransaction(sampleDoc.project.id, edited, {
			requestId: "external",
			expected: version,
		});
		await Promise.resolve();
		expect(useProjectStore.getState().transactionBusy).toBe(true);
		useProjectStore
			.getState()
			.setDocumentLive({ ...sampleDoc, project: { ...sampleDoc.project, title: "Gesture" } });
		expect(undo()).toBe(false);
		expect(useProjectStore.getState().document).toEqual(sampleDoc);
		finish(committed(edited, "external"));
		await expect(applying).resolves.toMatchObject({ requestId: "external" });
		expect(useProjectStore.getState().transactionBusy).toBe(false);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(undo()).toBe(false);
		bridgeMocks.commit.mockImplementation(async (_id, doc, guard) =>
			committed(doc, guard.requestId, "three"),
		);
		await useProjectStore.getState().saveDocument(useProjectStore.getState().document!);
		expect(bridgeMocks.commit.mock.calls.at(-1)?.[2].expected.revision).toBe("two");
		expect(useProjectStore.getState().transactionVersion?.revision).toBe("three");
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
	it("preserves dirty document and error on a guarded save conflict", async () => {
		await activate();
		const dirty = { ...sampleDoc, project: { ...sampleDoc.project, title: "Unsaved" } };
		useProjectStore.getState().setDocumentLive(dirty);
		bridgeMocks.commit.mockResolvedValue({
			success: false,
			errorCode: "CONFLICT",
			error: "Newer disk revision",
		});
		await expect(useProjectStore.getState().saveDocument(dirty)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: dirty,
			dirty: true,
			error: "Newer disk revision",
			transactionVersion: version,
		});
	});
	it("rebases queued GUI intent only across a confirmed local commit without losing its other changes", async () => {
		await activate();
		let finish!: (value: ReturnType<typeof committed>) => void;
		bridgeMocks.commit.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		bridgeMocks.commit.mockImplementationOnce(async (_id, doc, guard) =>
			committed(doc, guard.requestId, "three"),
		);
		const firstDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "First" },
			legacyEditor: { padding: 20 },
		};
		const first = useProjectStore.getState().saveDocument(firstDocument);
		const second = useProjectStore
			.getState()
			.saveDocument({ ...sampleDoc, project: { ...sampleDoc.project, title: "Second" } });
		await Promise.resolve();
		finish(committed(firstDocument, bridgeMocks.commit.mock.calls[0][2].requestId));
		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(true);
		expect(bridgeMocks.commit.mock.calls.map((call) => call[2].expected.revision)).toEqual([
			"one",
			"two",
		]);
		expect(useProjectStore.getState()).toMatchObject({
			transactionSyncPending: false,
			dirty: false,
			document: { project: { title: "Second" }, legacyEditor: { padding: 20 } },
			transactionVersion: { revision: "three" },
		});
		expect(await reconcileProjectTransactions(sampleDoc.project.id)).toBe("unchanged");
	});
	it("preserves the full newer GUI draft when controls publish each draft before saving", async () => {
		await activate();
		let finish!: (value: ReturnType<typeof committed>) => void;
		bridgeMocks.commit.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		bridgeMocks.commit.mockImplementationOnce(async (_id, doc, guard) =>
			committed(doc, guard.requestId, "three"),
		);
		const firstDocument = { ...sampleDoc, legacyEditor: { padding: 20 } };
		useProjectStore.getState().setDocument(firstDocument);
		const first = useProjectStore.getState().saveDocument(firstDocument);
		const secondDocument = { ...firstDocument, legacyEditor: { padding: 40 } };
		useProjectStore.getState().setDocument(secondDocument);
		const second = useProjectStore.getState().saveDocument(secondDocument);
		await Promise.resolve();
		finish(committed(firstDocument, bridgeMocks.commit.mock.calls[0][2].requestId));
		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(true);
		expect(bridgeMocks.commit.mock.calls[1][1]).toMatchObject({ legacyEditor: { padding: 40 } });
		expect(bridgeMocks.commit.mock.calls[1][2].expected.revision).toBe("two");
		expect(useProjectStore.getState()).toMatchObject({
			document: { legacyEditor: { padding: 40 } },
			dirty: false,
			transactionSyncPending: false,
		});
	});
	it("carries an unpublished structural save into a later multi-frame GUI gesture", async () => {
		await activate();
		let finish!: (value: ReturnType<typeof committed>) => void;
		bridgeMocks.commit.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		bridgeMocks.commit.mockImplementationOnce(async (_id, doc, guard) =>
			committed(doc, guard.requestId, "three"),
		);
		const firstDocument = {
			...sampleDoc,
			assets: [
				{ id: "a", kind: "video" as const, label: "A", originalPath: "/a.mp4", cameraTrack: null },
			],
		};
		const first = useProjectStore.getState().saveDocumentAsEdit(firstDocument);
		const frameOne = { ...useProjectStore.getState().document!, legacyEditor: { padding: 10 } };
		useProjectStore.getState().setDocumentLive(frameOne);
		const frameTwo = { ...frameOne, legacyEditor: { padding: 10, borderRadius: 10 } };
		useProjectStore.getState().setDocumentLive(frameTwo);
		const second = useProjectStore.getState().saveDocument(frameTwo);
		await Promise.resolve();
		finish(committed(firstDocument, bridgeMocks.commit.mock.calls[0][2].requestId));
		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(true);
		expect(bridgeMocks.commit.mock.calls[1][1]).toMatchObject({
			assets: firstDocument.assets,
			legacyEditor: { padding: 10, borderRadius: 10 },
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: { assets: firstDocument.assets, legacyEditor: { padding: 10, borderRadius: 10 } },
			dirty: false,
			transactionSyncPending: false,
		});
	});
	it("keeps newer live edits dirty and editable after a successful older save", async () => {
		await activate();
		let finish!: (value: ReturnType<typeof committed>) => void;
		bridgeMocks.commit.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const saved = { ...sampleDoc, project: { ...sampleDoc.project, title: "Saved" } };
		const saving = useProjectStore.getState().saveDocumentAsEdit(saved);
		await Promise.resolve();
		const live = { ...sampleDoc, legacyEditor: { padding: 35 } };
		useProjectStore.getState().setDocumentLive(live);
		finish(committed(saved, bridgeMocks.commit.mock.calls[0][2].requestId));
		await expect(saving).resolves.toBe(false);
		expect(useProjectStore.getState()).toMatchObject({
			transactionSyncPending: false,
			dirty: true,
			document: { project: { title: "Saved" }, legacyEditor: { padding: 35 } },
			transactionVersion: { revision: "two" },
		});
		bridgeMocks.commit.mockImplementationOnce(async (_id, doc, guard) =>
			committed(doc, guard.requestId, "three"),
		);
		await expect(
			useProjectStore.getState().saveDocument(useProjectStore.getState().document!),
		).resolves.toBe(true);
		expect(bridgeMocks.commit.mock.calls[1][2].expected.revision).toBe("two");
		expect(useProjectStore.getState().dirty).toBe(false);
	});
	it("does not bypass a real disk conflict after advancing through its own queued write", async () => {
		await activate();
		let finish!: (value: ReturnType<typeof committed>) => void;
		bridgeMocks.commit.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		bridgeMocks.commit.mockResolvedValueOnce({
			success: false,
			errorCode: "CONFLICT",
			error: "External disk edit",
		});
		const first = useProjectStore
			.getState()
			.saveDocument({ ...sampleDoc, project: { ...sampleDoc.project, title: "First" } });
		const second = useProjectStore
			.getState()
			.saveDocument({ ...sampleDoc, project: { ...sampleDoc.project, title: "Second" } });
		const outcomes = Promise.allSettled([first, second]);
		await Promise.resolve();
		finish(
			committed(
				{ ...sampleDoc, project: { ...sampleDoc.project, title: "First" } },
				bridgeMocks.commit.mock.calls[0][2].requestId,
			),
		);
		expect((await outcomes)[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
		expect(bridgeMocks.commit.mock.calls[1][2].expected.revision).toBe("two");
		expect(useProjectStore.getState()).toMatchObject({
			dirty: true,
			error: "External disk edit",
			transactionVersion: { revision: "two" },
			transactionSyncPending: false,
		});
	});
	it("rejects conflicting queued structures without leaving the live editor behind the known saved base", async () => {
		await activate();
		let finish!: (value: ReturnType<typeof committed>) => void;
		bridgeMocks.commit.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const firstDocument = {
			...sampleDoc,
			assets: [
				{ id: "a", kind: "video" as const, label: "A", originalPath: "/a.mp4", cameraTrack: null },
			],
		};
		const secondDocument = {
			...sampleDoc,
			assets: [
				{ id: "b", kind: "video" as const, label: "B", originalPath: "/b.mp4", cameraTrack: null },
			],
		};
		const first = useProjectStore.getState().saveDocument(firstDocument);
		const second = useProjectStore.getState().saveDocument(secondDocument);
		const outcomes = Promise.allSettled([first, second]);
		await Promise.resolve();
		finish(committed(firstDocument, bridgeMocks.commit.mock.calls[0][2].requestId));
		expect((await outcomes)[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
		expect(bridgeMocks.commit).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.assets.map((asset) => asset.id)).toEqual(["a"]);
		expect(useProjectStore.getState().transactionSyncPending).toBe(false);
		bridgeMocks.commit.mockImplementationOnce(async (_id, doc, guard) =>
			committed(doc, guard.requestId, "three"),
		);
		await expect(
			useProjectStore.getState().saveDocument(useProjectStore.getState().document!),
		).resolves.toBe(true);
		expect(useProjectStore.getState().document?.assets.map((asset) => asset.id)).toEqual(["a"]);
	});
	it("saves a blocked local version as a new project without changing the original", async () => {
		await activate();
		const local = { ...sampleDoc, project: { ...sampleDoc.project, title: "Unsaved" } };
		useProjectStore.setState({ document: local, dirty: true, transactionSyncPending: true });
		const copy = {
			...local,
			project: { ...local.project, id: "copy", title: "Unsaved (recovered copy)" },
		};
		bridgeMocks.importProject.mockResolvedValue({ success: true, document: copy });
		bridgeMocks.get.mockResolvedValue({ success: true, document: copy });
		await expect(resolveLocalTransactionConflict("save-copy")).resolves.toEqual({
			projectId: "copy",
			strategy: "save-copy",
		});
		expect(bridgeMocks.importProject.mock.calls[0][0]).toMatchObject({
			project: { id: sampleDoc.project.id, title: "Unsaved (recovered copy)" },
		});
		expect(bridgeMocks.commit).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "copy",
			document: copy,
			dirty: false,
			transactionBusy: false,
			transactionSyncPending: false,
		});
	});
	it("reloads the saved version only through the explicit local recovery choice", async () => {
		await activate();
		useProjectStore.setState({
			document: { ...sampleDoc, project: { ...sampleDoc.project, title: "Unsaved" } },
			dirty: true,
			transactionSyncPending: true,
		});
		bridgeMocks.get.mockResolvedValue({
			success: true,
			document: sampleDoc,
			transactionVersion: version,
		});
		await expect(resolveLocalTransactionConflict("reload")).resolves.toEqual({
			projectId: sampleDoc.project.id,
			strategy: "reload",
		});
		expect(useProjectStore.getState()).toMatchObject({
			document: sampleDoc,
			dirty: false,
			transactionSyncPending: false,
		});
		expect(bridgeMocks.importProject).not.toHaveBeenCalled();
		expect(bridgeMocks.commit).not.toHaveBeenCalled();
	});
	it("keeps dirty recovery state after load failure and reuses its already saved copy", async () => {
		await activate();
		useProjectStore.setState({ dirty: true, transactionSyncPending: true });
		const copy = { ...sampleDoc, project: { ...sampleDoc.project, id: "copy" } };
		bridgeMocks.importProject.mockResolvedValue({ success: true, document: copy });
		bridgeMocks.get.mockRejectedValueOnce(new Error("load failed"));
		await expect(resolveLocalTransactionConflict("save-copy")).rejects.toThrow("load failed");
		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			dirty: true,
			transactionSyncPending: true,
			transactionBusy: false,
		});
		bridgeMocks.get.mockResolvedValue({ success: true, document: copy });
		await resolveLocalTransactionConflict("save-copy");
		expect(bridgeMocks.importProject).toHaveBeenCalledTimes(1);
	});
	it("requires external receipt reconciliation before any local discard or copy choice", async () => {
		await activate();
		bridgeMocks.commit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(
			applyExternalProjectTransaction(sampleDoc.project.id, sampleDoc, {
				requestId: "external",
				expected: version,
			}),
		).rejects.toThrow();
		await expect(resolveLocalTransactionConflict("reload")).rejects.toMatchObject({
			code: "EXTERNAL_RECONCILIATION_REQUIRED",
		});
		await expect(resolveLocalTransactionConflict("save-copy")).rejects.toMatchObject({
			code: "EXTERNAL_RECONCILIATION_REQUIRED",
		});
		expect(bridgeMocks.get).not.toHaveBeenCalled();
		expect(bridgeMocks.importProject).not.toHaveBeenCalled();
	});
	it("checks an uncertain local request receipt before preserving its failed edit in a copy", async () => {
		await activate();
		const candidate = { ...sampleDoc, project: { ...sampleDoc.project, title: "Intended edit" } };
		bridgeMocks.commit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(useProjectStore.getState().saveDocumentAsEdit(candidate)).rejects.toThrow();
		const requestId = bridgeMocks.commit.mock.calls[0][2].requestId;
		bridgeMocks.receipt.mockResolvedValue({
			success: true,
			receipt: committed(candidate, requestId).receipt,
		});
		bridgeMocks.snapshot.mockResolvedValue({
			success: true,
			document: candidate,
			version: { ...version, revision: "two" },
		});
		const copy = { ...candidate, project: { ...candidate.project, id: "copy" } };
		bridgeMocks.importProject.mockResolvedValue({ success: true, document: copy });
		bridgeMocks.get.mockResolvedValue({ success: true, document: copy });
		await resolveLocalTransactionConflict("save-copy");
		expect(bridgeMocks.receipt).toHaveBeenCalledWith(sampleDoc.project.id, requestId);
		expect(bridgeMocks.importProject.mock.calls[0][0].project.title).toBe(
			"Intended edit (recovered copy)",
		);
		expect(bridgeMocks.commit).toHaveBeenCalledTimes(1);
	});
	it("does not discard local edits while their receipt is unavailable or absent from a changed snapshot", async () => {
		await activate();
		bridgeMocks.commit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(useProjectStore.getState().saveDocument(sampleDoc)).rejects.toThrow();
		bridgeMocks.receipt.mockResolvedValueOnce({ success: false, error: "offline" });
		await expect(resolveLocalTransactionConflict("reload")).rejects.toThrow("offline");
		bridgeMocks.receipt.mockResolvedValueOnce({ success: true, receipt: null });
		bridgeMocks.snapshot.mockResolvedValue({
			success: true,
			document: sampleDoc,
			version: { ...version, revision: "unknown" },
		});
		await expect(resolveLocalTransactionConflict("reload")).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(bridgeMocks.get).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			document: sampleDoc,
			dirty: true,
			transactionSyncPending: true,
			transactionBusy: false,
		});
	});
	it("allows explicit reload after receipt lookup proves a local request did not commit", async () => {
		await activate();
		bridgeMocks.commit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(useProjectStore.getState().saveDocument(sampleDoc)).rejects.toThrow();
		bridgeMocks.receipt.mockResolvedValue({ success: true, receipt: null });
		bridgeMocks.snapshot.mockResolvedValue({ success: true, document: sampleDoc, version });
		bridgeMocks.get.mockResolvedValue({
			success: true,
			document: sampleDoc,
			transactionVersion: version,
		});
		await resolveLocalTransactionConflict("reload");
		expect(useProjectStore.getState().transactionSyncPending).toBe(false);
	});
	it("keeps the barrier after uncertain durable commit, preventing stale edits and history movement", async () => {
		await activate();
		bridgeMocks.commit.mockResolvedValue({
			success: true,
			receipt: { requestId: "a", revision: "two", changed: true },
			errorCode: "SNAPSHOT_UNAVAILABLE",
		});
		await expect(
			applyExternalProjectTransaction(sampleDoc.project.id, sampleDoc, {
				requestId: "a",
				expected: version,
			}),
		).rejects.toMatchObject({ code: "EDITOR_SYNC_PENDING" });
		expect(useProjectStore.getState()).toMatchObject({
			transactionBusy: false,
			transactionSyncPending: true,
			dirty: true,
		});
		expect(undo()).toBe(false);
		await expect(
			useProjectStore.getState().loadProject(sampleDoc.project.id),
		).rejects.toMatchObject({ code: "EDITOR_BUSY" });
	});
	it("automatically adopts a reopened transaction project and restores only its immediately applicable Undo", async () => {
		const edited = { ...sampleDoc, project: { ...sampleDoc.project, title: "Edited" } };
		bridgeMocks.get.mockResolvedValue({
			success: true,
			document: edited,
			transactionVersion: { ...version, revision: "two" },
			undoRecovery: { requestId: "agent", afterRevision: "two", beforeDocument: sampleDoc },
		});
		await useProjectStore.getState().loadProject(sampleDoc.project.id);
		expect(useProjectStore.getState().transactionVersion?.revision).toBe("two");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(undo()).toBe(false);
	});
	it("reconciles a lost committed response and restores its Undo once", async () => {
		await activate();
		const edited = { ...sampleDoc, project: { ...sampleDoc.project, title: "Edited" } };
		bridgeMocks.commit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(
			applyExternalProjectTransaction(sampleDoc.project.id, edited, {
				requestId: "agent",
				expected: version,
			}),
		).rejects.toThrow("connection lost");
		bridgeMocks.snapshot.mockResolvedValue({
			success: true,
			document: edited,
			version: { ...version, revision: "two" },
			undoRecovery: { requestId: "agent", afterRevision: "two", beforeDocument: sampleDoc },
		});
		await expect(reconcileProjectTransactions(sampleDoc.project.id)).resolves.toBe("applied");
		await expect(reconcileProjectTransactions(sampleDoc.project.id)).resolves.toBe("unchanged");
		expect(useProjectStore.getState()).toMatchObject({
			document: edited,
			dirty: false,
			transactionSyncPending: false,
		});
		expect(undo()).toBe(true);
		expect(undo()).toBe(false);
	});
	it("does not reconcile an old request over a newer committed transaction", async () => {
		await activate();
		bridgeMocks.commit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(
			applyExternalProjectTransaction(sampleDoc.project.id, sampleDoc, {
				requestId: "agent",
				expected: version,
			}),
		).rejects.toThrow();
		bridgeMocks.snapshot.mockResolvedValue({
			success: true,
			document: sampleDoc,
			version: { ...version, revision: "three" },
		});
		await expect(reconcileProjectTransactions(sampleDoc.project.id)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(useProjectStore.getState().transactionSyncPending).toBe(true);
	});

	it("commits prepared guarded import and removal through normal Undo", async () => {
		await activate();
		const asset = {
			id: "asset_new",
			kind: "video",
			label: "video",
			originalPath: "/tmp/video.mp4",
			cameraTrack: null,
		};
		bridgeMocks.prepareAsset.mockResolvedValue({ asset });
		vi.mocked(window.electronAPI.findRecordingCamera).mockResolvedValue({ success: false });
		let revision = 1;
		bridgeMocks.commit.mockImplementation(async (_id, doc, guard) =>
			committed(doc, guard.requestId, String(++revision)),
		);
		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		expect(useProjectStore.getState().document?.assets).toHaveLength(1);
		await useProjectStore.getState().removeAsset(asset.id);
		expect(useProjectStore.getState().document?.assets).toHaveLength(0);
		await undo();
		expect(useProjectStore.getState().document?.assets).toHaveLength(1);
		await undo();
		expect(useProjectStore.getState().document?.assets).toHaveLength(0);
		expect(bridgeMocks.addAsset).not.toHaveBeenCalled();
		expect(bridgeMocks.removeAsset).not.toHaveBeenCalled();
	});

	it("includes the camera link in the single guarded asset commit", async () => {
		await activate();
		bridgeMocks.prepareAsset.mockResolvedValue({
			asset: {
				id: "camera_asset",
				kind: "video",
				label: "screen",
				originalPath: "/tmp/screen.mp4",
			},
		});
		vi.mocked(window.electronAPI.findRecordingCamera).mockResolvedValue({
			success: true,
			webcamVideoPath: "/tmp/camera.mp4",
			offsetMs: -12.7,
		});
		bridgeMocks.commit.mockImplementation(async (_id, doc, guard) =>
			committed(doc, guard.requestId),
		);
		const added = await useProjectStore.getState().addAsset("/tmp/screen.mp4");
		expect(added?.cameraTrack).toMatchObject({ sourcePath: "/tmp/camera.mp4", offsetMs: -13 });
		expect(bridgeMocks.commit).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.commit.mock.calls[0][1].assets[0].cameraTrack).toEqual(added?.cameraTrack);
	});

	it("does not publish a prepared asset over a concurrent local edit", async () => {
		await activate();
		bridgeMocks.prepareAsset.mockImplementation(async () => {
			useProjectStore
				.getState()
				.setDocument({ ...sampleDoc, project: { ...sampleDoc.project, title: "Local edit" } });
			return {
				asset: { id: "asset_new", kind: "video", label: "video", originalPath: "/tmp/video.mp4" },
			};
		});
		vi.mocked(window.electronAPI.findRecordingCamera).mockResolvedValue({ success: false });
		await expect(useProjectStore.getState().addAsset("/tmp/video.mp4")).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(useProjectStore.getState().document?.project.title).toBe("Local edit");
		expect(bridgeMocks.commit).not.toHaveBeenCalled();
	});

	it("createProject stores the returned document and bumps revision", async () => {
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });

		const doc = await useProjectStore.getState().createProject("Test");

		expect(doc.project.id).toBe("proj_test");
		const state = useProjectStore.getState();
		expect(state.projectId).toBe("proj_test");
		expect(state.document?.project.title).toBe("Test");
		expect(state.revision).toBe(1);
		expect(state.status).toBe("ready");
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	// Owner decision 2026-10-05: a new recording keeps the remembered camera place and
	// size but shows the camera as recorded. This test used to expect the remembered
	// "circle" mask to carry over.
	it("starts a new project plain with the remembered camera place and size in its real shape", async () => {
		saveEditorDefaultPreferences({
			...DEFAULT_EDITOR_SETTINGS,
			padding: 27,
			showBlur: true,
			webcamMaskShape: "circle",
			webcamAspectRatio: "16:9",
			webcamCornerRadius: 32,
			webcamFocalPoint: { cx: 0.3, cy: 0.7 },
			webcamLayoutPreset: "dual-frame",
			webcamSizePreset: 41,
			webcamPosition: { cx: 0.2, cy: 0.25 },
			webcamMirrored: true,
			cursor: { ...DEFAULT_EDITOR_SETTINGS.cursor, smoothing: 0.88 },
		});
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });

		const document = await useProjectStore.getState().createProject("Test");
		const settings = getEditorSettings(document);

		expect(settings.padding).toBe(0);
		expect(settings.showBlur).toBe(false);
		expect(settings).toMatchObject({
			webcamLayoutPreset: "picture-in-picture",
			webcamMaskShape: "rectangle",
			webcamAspectRatio: "source",
			webcamCornerRadius: 0,
			webcamZoom: 1,
			webcamFocalPoint: { cx: 0.5, cy: 0.5 },
			webcamSizePreset: 41,
			webcamPosition: { cx: 0.2, cy: 0.25 },
			webcamMirrored: true,
		});
		expect(settings.cursor.smoothing).toBe(0);
		expect(bridgeMocks.save).toHaveBeenCalledWith(document);
	});

	it("keeps a newly created project open when applying defaults cannot be saved", async () => {
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });

		await expect(useProjectStore.getState().createProject("Test")).resolves.toEqual(sampleDoc);

		expect(useProjectStore.getState()).toMatchObject({
			projectId: "proj_test",
			document: sampleDoc,
			status: "ready",
		});
		await vi.waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));
	});

	it("does not publish an older save after a newer save starts", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		let finishFirst: ((result: unknown) => void) | undefined;
		let finishSecond: ((result: unknown) => void) | undefined;
		bridgeMocks.save
			.mockImplementationOnce(
				(document) =>
					new Promise((resolve) => {
						finishFirst = () => resolve({ success: true, document });
					}),
			)
			.mockImplementationOnce(
				(document) =>
					new Promise((resolve) => {
						finishSecond = () => resolve({ success: true, document });
					}),
			);
		const firstDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "First" },
		};
		const secondDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Second" },
		};

		const firstSave = useProjectStore.getState().saveDocument(firstDocument);
		const secondSave = useProjectStore.getState().saveDocument(secondDocument);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		finishFirst?.({});
		await expect(firstSave).resolves.toBe(false);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		finishSecond?.({});
		await expect(secondSave).resolves.toBe(true);

		expect(useProjectStore.getState().document?.project.title).toBe("Second");
	});

	it("rejects a background continuation after a user save starts", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const guard = {
			revision: 1,
			mutationGeneration: getProjectMutationGeneration("proj_test"),
		};
		let finishUserSave: ((result: unknown) => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishUserSave = () => resolve({ success: true, document });
				}),
		);
		const userDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "User edit" },
		};
		const cameraDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Stale camera continuation" },
		};

		const userSave = useProjectStore.getState().saveDocumentAsEdit(userDocument);
		const cameraSave = useProjectStore.getState().saveDocumentIfCurrent(cameraDocument, guard);

		await expect(cameraSave).resolves.toBe(false);
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		finishUserSave?.({});
		await expect(userSave).resolves.toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
	});

	it("waits for an in-flight structural edit before a workspace transition reads state", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		let finishSave: (() => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishSave = () => resolve({ success: true, document });
				}),
		);
		const splitDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Split committed" },
		};

		const saving = useProjectStore.getState().saveDocumentAsEdit(splitDocument);
		let transitionReady = false;
		const waiting = waitForProjectMutations("proj_test").then(() => {
			transitionReady = true;
		});
		await Promise.resolve();
		expect(transitionReady).toBe(false);

		finishSave?.();
		await expect(saving).resolves.toBe(true);
		await waiting;

		expect(transitionReady).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Split committed");
	});

	it("rejects a background continuation after an asset mutation starts", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const guard = {
			revision: 1,
			mutationGeneration: getProjectMutationGeneration("proj_test"),
		};
		let finishRemoval: ((result: unknown) => void) | undefined;
		bridgeMocks.removeAsset.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRemoval = () => resolve({ document: sampleDoc });
				}),
		);
		const removal = useProjectStore.getState().removeAsset("asset-1");
		const cameraSave = useProjectStore.getState().saveDocumentIfCurrent(sampleDoc, guard);

		await expect(cameraSave).resolves.toBe(false);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		finishRemoval?.({});
		await expect(removal).resolves.toBeUndefined();
	});

	it("retries a background document patch against the latest user edit", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const completions: Array<(result: unknown) => void> = [];
		bridgeMocks.save.mockImplementation(
			(document) =>
				new Promise((resolve) => {
					completions.push(() => resolve({ success: true, document }));
				}),
		);

		const patching = useProjectStore.getState().applyDocumentPatch(
			"proj_test",
			(document) => ({
				...document,
				project: { ...document.project, title: `${document.project.title} + camera` },
			}),
			{ coalesceIntoHistory: true },
		);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		const userDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "User edit" },
		};
		const userSave = useProjectStore.getState().saveDocumentAsEdit(userDocument);
		completions[0]?.({});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		completions[1]?.({});
		await expect(userSave).resolves.toBe(true);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(3));
		completions[2]?.({});

		await expect(patching).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("User edit + camera");
	});

	it("coalesces a background patch into existing undo snapshots", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const userDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "User edit" },
		};
		await useProjectStore.getState().saveDocumentAsEdit(userDocument);

		await expect(
			useProjectStore.getState().applyDocumentPatch(
				"proj_test",
				(document) => ({
					...document,
					project: { ...document.project, title: `${document.project.title} + camera` },
				}),
				{ coalesceIntoHistory: true },
			),
		).resolves.toBe("applied");

		expect(useProjectStore.getState().document?.project.title).toBe("User edit + camera");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test + camera");
		expect(undo()).toBe(false);
	});

	it("coalesces a no-op background patch into a pending redo snapshot", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const imported = {
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Imported" },
		};
		await useProjectStore.getState().saveDocumentAsEdit(imported);
		expect(undo()).toBe(true);

		const patch = (document: AxcutDocument) =>
			document.project.title === "Imported"
				? {
						...document,
						project: { ...document.project, title: "Imported + camera" },
					}
				: document;
		await expect(
			useProjectStore
				.getState()
				.applyDocumentPatch("proj_test", patch, { coalesceIntoHistory: true }),
		).resolves.toBe("unchanged");

		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Imported + camera");
	});

	it("retries one transactional edit patch and keeps a newer edit in its Undo snapshot", async () => {
		const pendingAsset = {
			id: "recording-asset",
			kind: "video" as const,
			label: "Recording",
			originalPath: "/tmp/recording.mp4",
			recordingImportId: "recording-1",
			cameraTrack: null,
		};
		const partialImport = { ...sampleDoc, assets: [pendingAsset] };
		const stripPartialImport = (document: AxcutDocument): AxcutDocument => ({
			...document,
			assets: document.assets.filter((asset) => asset.recordingImportId !== "recording-1"),
		});
		useProjectStore.setState({
			projectId: "proj_test",
			document: partialImport,
			revision: 1,
			status: "ready",
			error: null,
		});
		const completions: Array<(result: unknown) => void> = [];
		bridgeMocks.save.mockImplementation(
			(document) =>
				new Promise((resolve) => {
					completions.push(() => resolve({ success: true, document }));
				}),
		);

		const importing = useProjectStore.getState().applyDocumentPatch(
			"proj_test",
			(document) => ({
				...document,
				project: { ...document.project, title: `${document.project.title} + recording` },
			}),
			{
				createHistorySnapshot: stripPartialImport,
				normalizeHistorySnapshots: stripPartialImport,
			},
		);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));

		const userDocument = {
			...partialImport,
			project: { ...partialImport.project, title: "User edit" },
		};
		const userSave = useProjectStore.getState().saveDocumentAsEdit(userDocument);
		completions[0]?.({});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(2));
		completions[1]?.({});
		await expect(userSave).resolves.toBe(true);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(3));
		completions[2]?.({});

		await expect(importing).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("User edit + recording");
		expect(useProjectStore.getState().document?.assets).toEqual([pendingAsset]);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
		expect(useProjectStore.getState().document?.assets).toEqual([]);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(useProjectStore.getState().document?.assets).toEqual([]);
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
		expect(useProjectStore.getState().document?.assets).toEqual([]);
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit + recording");
		expect(useProjectStore.getState().document?.assets).toEqual([pendingAsset]);
	});

	it("waits for an in-flight asset mutation before applying a document patch", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		let finishRemoval: ((result: unknown) => void) | undefined;
		bridgeMocks.removeAsset.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRemoval = () =>
						resolve({
							document: {
								...sampleDoc,
								project: { ...sampleDoc.project, title: "After removal" },
							},
						});
				}),
		);

		const removal = useProjectStore.getState().removeAsset("asset-1");
		const patching = useProjectStore.getState().applyDocumentPatch("proj_test", (document) => ({
			...document,
			project: { ...document.project, title: `${document.project.title} + camera` },
		}));
		await Promise.resolve();
		expect(bridgeMocks.save).not.toHaveBeenCalled();

		finishRemoval?.({});
		await removal;
		await expect(patching).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("After removal + camera");
	});

	it("does not publish a completed save after the user switches projects", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		let finishSave: ((result: unknown) => void) | undefined;
		bridgeMocks.save.mockImplementationOnce(
			(document) =>
				new Promise((resolve) => {
					finishSave = () => resolve({ success: true, document });
				}),
		);
		const saving = useProjectStore.getState().saveDocument({
			...sampleDoc,
			project: { ...sampleDoc.project, title: "Late save" },
		});
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const otherDocument = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "proj_other", title: "Other" },
		};
		useProjectStore.setState({
			projectId: "proj_other",
			document: otherDocument,
			revision: 2,
		});

		finishSave?.({});
		await expect(saving).resolves.toBe(false);

		expect(useProjectStore.getState().projectId).toBe("proj_other");
		expect(useProjectStore.getState().document?.project.title).toBe("Other");
	});

	it("loadLatestProject applies transaction identity and undo through the shared loader", async () => {
		const edited = { ...sampleDoc, project: { ...sampleDoc.project, title: "Edited" } };
		bridgeMocks.getLatest.mockResolvedValue({
			success: true,
			document: edited,
			transactionVersion: { ...version, revision: "two" },
			undoRecovery: { requestId: "agent", afterRevision: "two", beforeDocument: sampleDoc },
		});

		await useProjectStore.getState().loadLatestProject();

		expect(bridgeMocks.getLatest).toHaveBeenCalledOnce();
		expect(bridgeMocks.get).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: edited,
			transactionVersion: { revision: "two" },
			status: "ready",
			dirty: false,
		});
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(undo()).toBe(false);
	});

	it("loadLatestProject leaves an empty library idle without an error", async () => {
		bridgeMocks.getLatest.mockResolvedValue({ success: true });

		await useProjectStore.getState().loadLatestProject();

		expect(useProjectStore.getState()).toMatchObject({
			projectId: null,
			document: null,
			status: "idle",
			error: null,
		});
		expect(bridgeMocks.get).not.toHaveBeenCalled();
	});

	it("loadLatestProject clears an earlier startup error when retry returns empty", async () => {
		useProjectStore.setState({ status: "error", error: "EACCES" });
		bridgeMocks.getLatest.mockResolvedValue({ success: true });

		await useProjectStore.getState().loadLatestProject();

		expect(useProjectStore.getState()).toMatchObject({
			projectId: null,
			document: null,
			status: "idle",
			error: null,
		});
	});

	it("loadLatestProject preserves an open document when latest is empty", async () => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			status: "ready",
		});
		bridgeMocks.getLatest.mockResolvedValue({ success: true });

		await useProjectStore.getState().loadLatestProject();

		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			status: "ready",
			error: null,
		});
	});

	it("loadLatestProject does not publish a late result after stale navigation", async () => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
			error: null,
		});
		let finishLoad!: () => void;
		bridgeMocks.getLatest.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () =>
						resolve({
							success: true,
							document: {
								...sampleDoc,
								project: { ...sampleDoc.project, id: "latest", title: "Latest" },
							},
						});
				}),
		);
		let canApply = true;
		const loading = useProjectStore.getState().loadLatestProject({
			canApply: () => canApply,
		});
		expect(useProjectStore.getState().status).toBe("loading");
		canApply = false;
		const recording = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "new-recording", title: "New recording" },
		};
		useProjectStore.setState({
			projectId: recording.project.id,
			document: recording,
			revision: 8,
			status: "ready",
		});
		const published = useProjectStore.getState();
		finishLoad();
		await loading;
		expect(useProjectStore.getState()).toBe(published);
		expect(bridgeMocks.get).not.toHaveBeenCalled();
		await waitForProjectMutations(sampleDoc.project.id);
	});

	it("loadProject handles a failed bridge response by setting error status", async () => {
		bridgeMocks.get.mockResolvedValue({ success: false, error: "not found" });

		await useProjectStore.getState().loadProject("proj_x");

		const state = useProjectStore.getState();
		expect(state.status).toBe("error");
		expect(state.error).toBe("not found");
	});

	it("does no loading work when the navigation guard is already blocked", async () => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
			error: "Previous warning",
		});
		const before = useProjectStore.getState();
		const generation = getProjectMutationGeneration(sampleDoc.project.id);
		await before.loadProject("library-project", { canApply: () => false });
		expect(bridgeMocks.get).not.toHaveBeenCalled();
		expect(useProjectStore.getState()).toBe(before);
		expect(getProjectMutationGeneration(sampleDoc.project.id)).toBe(generation);
	});

	it("restores only its owned loading status when a pending handoff blocks the response", async () => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
			error: "Previous warning",
		});
		let finishLoad!: () => void;
		bridgeMocks.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ success: true, document: sampleDoc });
				}),
		);
		let canApply = true;
		const loading = useProjectStore.getState().loadProject("library-project", {
			canApply: () => canApply,
		});
		expect(useProjectStore.getState().status).toBe("loading");
		let mutationsFinished = false;
		const mutations = waitForProjectMutations(sampleDoc.project.id).then(() => {
			mutationsFinished = true;
		});
		await Promise.resolve();
		expect(mutationsFinished).toBe(false);
		canApply = false;
		finishLoad();
		await loading;
		await mutations;
		expect(mutationsFinished).toBe(true);
		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			revision: 7,
			status: "ready",
			error: "Previous warning",
		});
		expect(useProjectStore.getState().document).toBe(sampleDoc);
	});

	it.each([
		"different-project",
		"same-project",
	])("does not replace a newer %s document after a deferred load", async (identity) => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
		});
		let finishLoad!: () => void;
		bridgeMocks.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ success: true, document: sampleDoc });
				}),
		);
		const loading = useProjectStore.getState().loadProject("library-project", {
			canApply: () => true,
		});
		const recording = {
			...sampleDoc,
			project: {
				...sampleDoc.project,
				id: identity === "different-project" ? "new-recording" : sampleDoc.project.id,
				title: "New recording",
			},
		};
		useProjectStore.setState({
			projectId: recording.project.id,
			document: recording,
			revision: 8,
			status: "ready",
			error: "Current warning",
		});
		const published = useProjectStore.getState();
		finishLoad();
		await loading;
		expect(useProjectStore.getState()).toBe(published);
		await waitForProjectMutations(sampleDoc.project.id);
	});

	it("does not publish a late load failure over a newer recording", async () => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
		});
		let failLoad!: () => void;
		bridgeMocks.get.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					failLoad = () => reject(new Error("Old library file disappeared"));
				}),
		);
		const loading = useProjectStore.getState().loadProject("library-project", {
			canApply: () => true,
		});
		const recording = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "new-recording" },
		};
		useProjectStore.setState({
			projectId: recording.project.id,
			document: recording,
			revision: 8,
			status: "ready",
			error: null,
		});
		const published = useProjectStore.getState();
		failLoad();
		await loading;
		expect(useProjectStore.getState()).toBe(published);
		await waitForProjectMutations(sampleDoc.project.id);
	});

	it.each([
		["document", { document: { ...sampleDoc, project: { ...sampleDoc.project, title: "Newer" } } }],
		["revision", { revision: 8 }],
		["status", { status: "error" as const, error: "New failure" }],
		["error", { error: "New warning" }],
	] as const)("does not restore canceled loading status over a newer %s", async (_field, change) => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
			error: null,
		});
		let finishLoad!: () => void;
		bridgeMocks.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ success: true, document: sampleDoc });
				}),
		);
		let canApply = true;
		const loading = useProjectStore.getState().loadProject("library-project", {
			canApply: () => canApply,
		});
		useProjectStore.setState(change);
		const published = useProjectStore.getState();
		canApply = false;
		finishLoad();
		await loading;
		expect(useProjectStore.getState()).toBe(published);
		await waitForProjectMutations(sampleDoc.project.id);
	});

	it("does not restore old status over a newer pending load of the same initial project", async () => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
		});
		let finishFirst!: () => void;
		let finishSecond!: () => void;
		bridgeMocks.get
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishFirst = () => resolve({ success: true, document: sampleDoc });
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishSecond = () => resolve({ success: true, document: sampleDoc });
					}),
			);
		let canApplyFirst = true;
		const first = useProjectStore.getState().loadProject("first-project", {
			canApply: () => canApplyFirst,
		});
		const second = useProjectStore.getState().loadProject(sampleDoc.project.id);
		canApplyFirst = false;
		const pendingSecond = useProjectStore.getState();
		finishFirst();
		await first;
		expect(useProjectStore.getState()).toBe(pendingSecond);
		expect(useProjectStore.getState().status).toBe("loading");
		finishSecond();
		await second;
		expect(useProjectStore.getState().status).toBe("ready");
		await waitForProjectMutations(sampleDoc.project.id);
	});

	it("loads a current guarded project normally", async () => {
		bridgeMocks.get.mockResolvedValueOnce({ success: true, document: sampleDoc });
		await useProjectStore.getState().loadProject(sampleDoc.project.id, { canApply: () => true });
		expect(useProjectStore.getState()).toMatchObject({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			status: "ready",
			error: null,
		});
	});

	it("does not restore canceled loading status over a newer pending project creation", async () => {
		useProjectStore.setState({
			projectId: sampleDoc.project.id,
			document: sampleDoc,
			revision: 7,
			status: "ready",
		});
		let finishLoad!: () => void;
		let finishCreate!: () => void;
		bridgeMocks.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = () => resolve({ success: true, document: sampleDoc });
				}),
		);
		const recording = {
			...sampleDoc,
			project: { ...sampleDoc.project, id: "new-recording", title: "New recording" },
		};
		bridgeMocks.create.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishCreate = () => resolve({ success: true, document: recording });
				}),
		);
		let canApply = true;
		const loading = useProjectStore.getState().loadProject("library-project", {
			canApply: () => canApply,
		});
		const creating = useProjectStore.getState().createProject("New recording");
		const pendingCreation = useProjectStore.getState();
		canApply = false;
		finishLoad();
		await loading;
		expect(useProjectStore.getState()).toBe(pendingCreation);
		expect(useProjectStore.getState().status).toBe("loading");
		finishCreate();
		await creating;
		expect(useProjectStore.getState()).toMatchObject({
			projectId: "new-recording",
			status: "ready",
		});
		await waitForProjectMutations(sampleDoc.project.id);
	});

	it("addAsset replaces the document and bumps revision", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const updatedDoc = {
			...sampleDoc,
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "screen.webm",
					originalPath: "/tmp/screen.webm",
				},
			],
			project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
		};
		bridgeMocks.addAsset.mockResolvedValue({ assetId: "asset_1", document: updatedDoc });

		const asset = await useProjectStore.getState().addAsset("/tmp/screen.webm");

		expect(asset?.id).toBe("asset_1");
		expect(useProjectStore.getState().revision).toBe(2);
		expect(useProjectStore.getState().document?.assets).toHaveLength(1);
	});

	it("addAsset resolves an independent camera for every asset added, not just the first", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockImplementation(async (path: string) => {
			if (path === "/tmp/screen1.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen1-webcam.webm", offsetMs: 0 };
			}
			if (path === "/tmp/screen2.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen2-webcam.webm", offsetMs: 0 };
			}
			return { success: false, error: "No camera attached to this recording" };
		});

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{
						id: "asset_1",
						kind: "video",
						label: "screen1.webm",
						originalPath: "/tmp/screen1.webm",
					},
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});
		const firstAsset = await useProjectStore.getState().addAsset("/tmp/screen1.webm");

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_2",
			document: {
				...useProjectStore.getState().document,
				assets: [
					...useProjectStore.getState().document!.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "screen2.webm",
						originalPath: "/tmp/screen2.webm",
					},
				],
			},
		});
		const secondAsset = await useProjectStore.getState().addAsset("/tmp/screen2.webm");

		const assets = useProjectStore.getState().document?.assets ?? [];
		expect(assets).toHaveLength(2);
		expect(assets.find((a) => a.id === "asset_1")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen1-webcam.webm",
		);
		expect(assets.find((a) => a.id === "asset_2")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen2-webcam.webm",
		);
		expect(firstAsset?.cameraTrack?.sourcePath).toBe("/tmp/screen1-webcam.webm");
		expect(secondAsset?.cameraTrack?.sourcePath).toBe("/tmp/screen2-webcam.webm");
	});

	it("addAsset links the camera when the recorder measured a sub-millisecond offset", async () => {
		// The native capture paths derive this from `performance.now()` (100 µs
		// resolution), so the offset is almost never a whole number — while
		// `cameraTrackSchema.offsetMs` is an int. Unrounded, the document failed
		// validation, the catch below treated it as a lookup failure, and a
		// recording that HAD a camera silently lost it.
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: true,
			webcamVideoPath: "/tmp/screen-webcam.webm",
			offsetMs: -192.80000000447035,
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "screen.mp4", originalPath: "/tmp/screen.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/screen.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		const camera = useProjectStore.getState().document?.assets[0]?.cameraTrack;
		expect(camera?.sourcePath).toBe("/tmp/screen-webcam.webm");
		expect(camera?.offsetMs).toBe(-193);
	});

	it("addAsset stays silent (no toast) when a plain imported video has no camera", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: false,
			error: "No camera attached to this recording",
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.assets[0]?.cameraTrack).toBeNull();
	});

	it("addAsset toasts when the camera lookup itself throws", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockRejectedValue(new Error("bridge exploded"));
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).toHaveBeenCalledTimes(1);
		expect(toastMocks.error.mock.calls[0][0]).toContain("video.mp4");
	});

	it("removeAsset requires a loaded project", async () => {
		await expect(useProjectStore.getState().removeAsset("asset_x")).rejects.toThrow(
			"No project loaded",
		);
	});

	it("clear resets the store", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 5,
			status: "ready",
			error: null,
		});
		useProjectStore.getState().clear();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: null,
			document: null,
			revision: 0,
			status: "idle",
			error: null,
		});
	});
});

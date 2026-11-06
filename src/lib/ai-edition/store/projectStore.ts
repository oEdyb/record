import { create } from "zustand";
import { nativeBridgeClient } from "@/native/client";
import type {
	AiEditionProjectVersion,
	AiEditionTransactionReceipt,
	AiEditionUndoRecovery,
	AiEditionWriteGuard,
} from "@/native/contracts";
import { removeAssetFromDocument } from "../document/assets";
import {
	type Interval,
	replaceTimeline as replaceTimelineOp,
	restoreFullTimeline as restoreFullTimelineOp,
} from "../document/timeline";
import { type AxcutAsset, type AxcutDocument, assetSchema, documentSchema } from "../schema";
import {
	clearDocumentHistory,
	patchDocumentHistory,
	recordDocumentSnapshot,
} from "./documentHistory";
import { applyNewProjectPreferences, loadEditingPreferences } from "./editingPreferences";
import { ProjectActivity } from "./projectActivity";
import {
	initialProjectLifecycle,
	type ProjectEvent,
	type ProjectLifecycle,
	projectBusy,
	projectCopy,
	projectRequest,
	projectSyncPending,
	transitionProject,
} from "./projectLifecycle";

// ponytail: thin Zustand wrapper over the native-bridge client. Keeps the
// current project + revision counter in renderer memory; mutations round-trip
// through the main process via the bridge so disk state stays authoritative.

type ProjectStatus = "idle" | "loading" | "ready" | "error";
type DocumentPatchResult = "applied" | "unchanged" | "project-changed" | "conflict";
type ProjectDocumentPatch = (document: AxcutDocument) => AxcutDocument;

export interface ProjectState {
	lifecycle: ProjectLifecycle;
	projectId: string | null;
	document: AxcutDocument | null;
	revision: number;
	transactionVersion: AiEditionProjectVersion | null;
	transactionBusy: boolean;
	transactionSyncPending: boolean;
	lastTransactionReceipt: AiEditionTransactionReceipt | null;
	status: ProjectStatus;
	error: string | null;
	sourceDurationSec: number;
	currentTimeSec: number;
	/** Single source of truth for "is the timeline transport playing?" — previously
	 *  duplicated as separate local state in the editor shell AND VirtualPreview, each
	 *  independently wired to the same raw <video> DOM events, which let one advance
	 *  a clip boundary while the other unconditionally stopped playback. */
	playing: boolean;
	/** True when the in-memory document has local changes that haven't been written to disk yet. */
	dirty: boolean;
	/** Timestamp of the most recent successful save (used by the titlebar indicator). */
	lastSavedAt: Date | null;

	loadProject: (projectId: string, options?: { canApply: () => boolean }) => Promise<void>;
	loadLatestProject: (options?: { canApply: () => boolean }) => Promise<void>;
	createProject: (title: string) => Promise<AxcutDocument>;
	refresh: () => Promise<void>;
	addAsset: (
		path: string,
		label?: string,
		options?: { recordingImportId?: string },
	) => Promise<AxcutAsset | null>;
	removeAsset: (assetId: string) => Promise<void>;
	saveDocument: (document: AxcutDocument) => Promise<boolean>;
	/** Persist a non-undo continuation only if no save or edit started after its base snapshot. */
	saveDocumentIfCurrent: (
		document: AxcutDocument,
		guard: { revision: number; mutationGeneration: number },
	) => Promise<boolean>;
	/** Persist one user-visible edit and store its complete pre-edit document for Undo. */
	saveDocumentAsEdit: (
		document: AxcutDocument,
		historySnapshot?: AxcutDocument,
		agentHistory?: AiEditionWriteGuard["agentHistory"],
		requestId?: string,
	) => Promise<boolean>;
	/** Merge a background enhancement into the latest document without adding an Undo step. */
	applyDocumentPatch: (
		projectId: string,
		patch: ProjectDocumentPatch,
		options?: {
			coalesceIntoHistory?: boolean;
			agentHistory?: AiEditionWriteGuard["agentHistory"];
			requestId?: string;
			maximumAttempts?: number;
			/**
			 * Record this successful patch as one user-visible edit. The snapshot is
			 * derived from the base of each retry so a concurrent user edit remains
			 * present when Undo removes only this transaction.
			 */
			createHistorySnapshot?: (base: AxcutDocument) => AxcutDocument;
			/** Normalize snapshots captured while a multi-step transaction was still partial. */
			normalizeHistorySnapshots?: ProjectDocumentPatch;
		},
	) => Promise<DocumentPatchResult>;
	setDocument: (document: AxcutDocument) => void;
	/** Update a live gesture without adding an Undo snapshot for each frame. */
	setDocumentLive: (document: AxcutDocument) => void;
	restoreDocumentFromHistory: (document: AxcutDocument) => void;
	replaceTimeline: (intervals: Interval[], reason: string) => Promise<void>;
	restoreFullTimeline: () => Promise<void>;
	setSourceDuration: (sec: number) => void;
	setCurrentTime: (sec: number) => void;
	setPlaying: (playing: boolean) => void;
	markClean: () => void;
	clear: () => void;
}

function parseDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}

let persistQueue: Promise<void> = Promise.resolve();
const activity = new ProjectActivity();

class ProjectTransactionSessionError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}
function localRequest() {
	const request = projectRequest(useProjectStore.getState().lifecycle);
	return request?.kind === "local" ? request : null;
}
function externalRequest() {
	const request = projectRequest(useProjectStore.getState().lifecycle);
	return request?.kind === "external"
		? { projectId: request.projectId, requestId: request.guard.requestId }
		: null;
}
function draftBase() {
	return useProjectStore.getState().lifecycle.draft.base;
}
function recoveryCopy() {
	return projectCopy(useProjectStore.getState().lifecycle);
}

const recoveredUndoRequests = new Set<string>();
function restoreRecoveryUndo(projectId: string, recovery?: AiEditionUndoRecovery) {
	if (!recovery) return;
	const key = `${projectId}:${recovery.requestId}`;
	if (recoveredUndoRequests.has(key)) return;
	const before = parseDocument(recovery.beforeDocument);
	if (before.project.id !== projectId)
		throw new ProjectTransactionSessionError(
			"IDENTITY_CHANGED",
			"Undo recovery belongs to a different project",
		);
	recordDocumentSnapshot(before);
	recoveredUndoRequests.add(key);
}
/** Reconcile only the blocked external request. Never discard a newer local edit
 * or apply an old receipt over a later committed transaction. */
export async function reconcileProjectTransactions(
	projectId: string,
): Promise<"applied" | "not-committed" | "unchanged"> {
	const before = useProjectStore.getState();
	if (before.projectId !== projectId || !before.document)
		throw new ProjectTransactionSessionError("PROJECT_CHANGED", "Project is no longer active");
	if (!before.transactionSyncPending) return "unchanged";
	if (externalRequest()?.projectId !== projectId)
		throw new ProjectTransactionSessionError(
			"LOCAL_RECONCILIATION_REQUIRED",
			"Local edits need explicit conflict recovery",
		);
	const pendingExternal = externalRequest();
	if (!pendingExternal)
		throw new ProjectTransactionSessionError(
			"PROJECT_CHANGED",
			"External request ownership changed",
		);
	const requestId = pendingExternal.requestId;
	const snapshot = await nativeBridgeClient.aiEdition.snapshot(projectId);
	const current = useProjectStore.getState();
	if (
		current.projectId !== projectId ||
		current.revision !== before.revision ||
		current.lifecycle.epoch !== before.lifecycle.epoch ||
		projectRequest(current.lifecycle) !== projectRequest(before.lifecycle)
	)
		throw new ProjectTransactionSessionError(
			"PROJECT_CHANGED",
			"Editor changed during reconciliation",
		);
	if (!snapshot.success || !snapshot.document || !snapshot.version)
		throw new ProjectTransactionSessionError(
			snapshot.errorCode ?? "UNAVAILABLE",
			snapshot.error ?? "Recovery snapshot unavailable",
		);
	if (sameVersion(before.transactionVersion, snapshot.version)) {
		updateProject({}, [
			{ type: "view", view: { kind: useProjectStore.getState().lifecycle.view.kind, error: null } },
			{ type: "draft", kind: "clean" },
			{ type: "reconciled" },
		]);

		return "not-committed";
	}
	if (
		snapshot.undoRecovery?.requestId !== requestId ||
		snapshot.undoRecovery.afterRevision !== snapshot.version.revision
	)
		throw new ProjectTransactionSessionError(
			"CONFLICT",
			"A newer or unrecoverable transaction requires explicit review",
		);
	const document = parseDocument(snapshot.document);
	if (document.project.id !== projectId)
		throw new ProjectTransactionSessionError(
			"IDENTITY_CHANGED",
			"Recovery document identity mismatch",
		);
	restoreRecoveryUndo(projectId, snapshot.undoRecovery);
	updateProject(
		{
			document,
			transactionVersion: snapshot.version,
			revision: current.revision + 1,
			lastSavedAt: new Date(),
		},
		[
			{ type: "view", view: { kind: useProjectStore.getState().lifecycle.view.kind, error: null } },
			{ type: "draft", kind: "clean" },
			{ type: "reconciled" },
		],
	);

	return "applied";
}
/** Explicit user choice only. Reload discards the unsaved local version; saving
 * a copy preserves it in a new project and never writes the conflicted original. */
export async function resolveLocalTransactionConflict(
	strategy: "save-copy" | "reload",
): Promise<{ projectId: string; strategy: "save-copy" | "reload" }> {
	const before = useProjectStore.getState();
	if (strategy !== "save-copy" && strategy !== "reload")
		throw new ProjectTransactionSessionError("INVALID_RECOVERY", "Unknown recovery choice");
	if (!before.projectId || !before.document)
		throw new ProjectTransactionSessionError("PROJECT_CHANGED", "No active project to recover");
	const projectId = before.projectId;
	if (externalRequest()?.projectId === projectId)
		throw new ProjectTransactionSessionError(
			"EXTERNAL_RECONCILIATION_REQUIRED",
			"Reconcile the external transaction receipt before choosing local recovery",
		);
	if (before.transactionBusy || activity.active(projectId) > 0)
		throw new ProjectTransactionSessionError(
			"EDITOR_BUSY",
			"Wait for active saves before recovery",
		);
	if (!before.transactionSyncPending && !before.error)
		throw new ProjectTransactionSessionError(
			"NO_CONFLICT",
			"The project has no conflict to recover",
		);
	const assertCurrent = () => {
		const current = useProjectStore.getState();
		if (
			current.projectId !== projectId ||
			current.revision !== before.revision ||
			current.lifecycle.epoch !== before.lifecycle.epoch
		)
			throw new ProjectTransactionSessionError("PROJECT_CHANGED", "Editor changed during recovery");
	};
	const owner = Symbol("recovery");
	updateProject({}, [{ type: "recover", owner }]);
	try {
		const pending = localRequest()?.projectId === projectId ? localRequest() : null;
		if (pending) {
			const receipt = await nativeBridgeClient.aiEdition.receipt(projectId, pending.requestId);
			assertCurrent();
			if (!receipt.success || receipt.receipt === undefined)
				throw new ProjectTransactionSessionError(
					"EDITOR_SYNC_PENDING",
					receipt.error ?? "Local commit receipt is still unavailable",
				);
			const snapshot = await nativeBridgeClient.aiEdition.snapshot(projectId);
			assertCurrent();
			if (!snapshot.success || !snapshot.version || !snapshot.document)
				throw new ProjectTransactionSessionError(
					"EDITOR_SYNC_PENDING",
					snapshot.error ?? "Recovery snapshot is unavailable",
				);
			if (receipt.receipt) {
				if (
					receipt.receipt.requestId !== pending.requestId ||
					snapshot.version.mutationIdentity !== pending.expected.mutationIdentity
				)
					throw new ProjectTransactionSessionError(
						"CONFLICT",
						"Local receipt does not belong to the saved project",
					);
			} else if (!sameVersion(pending.expected, snapshot.version)) {
				throw new ProjectTransactionSessionError(
					"CONFLICT",
					"Saved project changed without a matching local receipt",
				);
			}
			// Preserve the request until recovery publishes, so a failed retry still
			// checks the exact receipt rather than treating uncertainty as a normal conflict.
		}
		let targetId = projectId;
		if (strategy === "save-copy") {
			const copy = recoveryCopy();
			if (copy?.projectId === projectId && copy.revision === before.revision) {
				targetId = copy.copyId;
			} else {
				const local =
					pending && pending.base && equalJson(before.document, pending.base)
						? pending.candidate
						: before.document;
				const copy = await nativeBridgeClient.aiEdition.importProject({
					...local,
					project: { ...local.project, title: `${local.project.title} (recovered copy)` },
				});
				assertCurrent();
				if (!copy.success || !copy.document)
					throw new Error(copy.error ?? "Could not save a recovery copy");
				const document = parseDocument(copy.document);
				if (document.project.id === projectId)
					throw new ProjectTransactionSessionError(
						"IDENTITY_CHANGED",
						"Recovery copy must have a new project identity",
					);
				targetId = document.project.id;
				updateProject({}, [
					{ type: "copy", owner, copy: { projectId, revision: before.revision, copyId: targetId } },
				]);
			}
		}
		const loaded = await nativeBridgeClient.aiEdition.get(targetId);
		assertCurrent();
		if (!loaded.success || !loaded.document)
			throw new Error(loaded.error ?? "Could not load recovered project");
		const document = parseDocument(loaded.document);
		if (document.project.id !== targetId)
			throw new ProjectTransactionSessionError(
				"IDENTITY_CHANGED",
				"Recovered project identity mismatch",
			);
		if (
			loaded.transactionVersion &&
			loaded.undoRecovery?.afterRevision === loaded.transactionVersion.revision
		) {
			const undoDocument = parseDocument(loaded.undoRecovery.beforeDocument);
			if (undoDocument.project.id !== targetId)
				throw new ProjectTransactionSessionError(
					"IDENTITY_CHANGED",
					"Recovery Undo belongs to another project",
				);
		}
		clearDocumentHistory();
		recoveredUndoRequests.clear();
		localCommitLineage.delete(projectId);
		updateProject(
			{
				projectId: targetId,
				document,
				revision: before.revision + 1,
				transactionVersion: loaded.transactionVersion ?? null,
				lastTransactionReceipt: null,
				lastSavedAt: new Date(),
				playing: false,
			},
			[
				{ type: "view", view: { kind: "ready", error: null } },
				{ type: "draft", kind: "clean" },
				{ type: "reconciled" },
			],
		);
		if (
			loaded.transactionVersion &&
			loaded.undoRecovery?.afterRevision === loaded.transactionVersion.revision
		)
			restoreRecoveryUndo(targetId, loaded.undoRecovery);
		return { projectId: targetId, strategy };
	} catch (error) {
		if (useProjectStore.getState().projectId === projectId)
			updateProject({}, [
				{
					type: "view",
					view: {
						kind: useProjectStore.getState().lifecycle.view.kind,
						error: error instanceof Error ? error.message : String(error),
					},
				},
				{ type: "draft", kind: "dirty" },
				{ type: "block" },
			]);
		throw error;
	} finally {
		if (useProjectStore.getState().lifecycle.editing.kind === "recovering")
			updateProject({}, [{ type: "finish", owner }]);
	}
}

function sameVersion(a: AiEditionProjectVersion | null, b: AiEditionProjectVersion) {
	return (
		a?.revision === b.revision &&
		a.fileHash === b.fileHash &&
		a.mutationIdentity === b.mutationIdentity
	);
}
export function isProjectTransactionBlocked(): boolean {
	const state = useProjectStore.getState();
	return state.transactionBusy || state.transactionSyncPending;
}
function assertTransactionIdle(projectId: string) {
	const state = useProjectStore.getState();
	if (state.projectId !== projectId || !state.document || state.status !== "ready")
		throw new ProjectTransactionSessionError(
			"PROJECT_CHANGED",
			"Project is not the active ready document",
		);
	if (state.dirty || isProjectTransactionBlocked() || activity.active(projectId) > 0)
		throw new ProjectTransactionSessionError(
			"EDITOR_BUSY",
			"Finish pending editor changes before applying a transaction",
		);
	return state;
}
/** Explicit opt-in only. No new endpoint is called for ordinary unadopted projects. */
export async function activateProjectTransactions(
	projectId: string,
): Promise<AiEditionProjectVersion> {
	const before = assertTransactionIdle(projectId);
	const generation = getProjectMutationGeneration(projectId);
	const result = await nativeBridgeClient.aiEdition.snapshot(projectId);
	const current = assertTransactionIdle(projectId);
	if (
		current.revision !== before.revision ||
		current.lifecycle.epoch !== before.lifecycle.epoch ||
		getProjectMutationGeneration(projectId) !== generation
	)
		throw new ProjectTransactionSessionError("CONFLICT", "Editor changed during activation");
	if (!result.success || !result.version || !result.document)
		throw new ProjectTransactionSessionError(
			result.errorCode ?? "UNAVAILABLE",
			result.error ?? "Saved snapshot unavailable",
		);
	const document = parseDocument(result.document);
	if (
		document.project.id !== projectId ||
		JSON.stringify(document) !== JSON.stringify(parseDocument(current.document))
	)
		throw new ProjectTransactionSessionError(
			"CONFLICT",
			"Saved content differs from the live editor; activation refused",
		);
	localCommitLineage.delete(projectId);
	updateProject({ transactionVersion: result.version, lastTransactionReceipt: null });
	return result.version;
}
/** Commit one prepared replacement through the normal history path. No transport
 * exposes this until owner leases, import and restart reconciliation are complete. */
export async function applyExternalProjectTransaction(
	projectId: string,
	document: AxcutDocument,
	guard: AiEditionWriteGuard,
): Promise<AiEditionTransactionReceipt> {
	const state = assertTransactionIdle(projectId);
	if (!sameVersion(state.transactionVersion, guard.expected))
		throw new ProjectTransactionSessionError("CONFLICT", "Prepared transaction version is stale");
	if (document.project.id !== projectId)
		throw new ProjectTransactionSessionError(
			"IDENTITY_CHANGED",
			"Prepared document belongs to another project",
		);
	const owner = Symbol("external-commit");
	updateProject({}, [
		{ type: "external", owner, projectId, guard: { ...guard, recordUndo: true } },
	]);
	try {
		const saving = saveProjectEdit(document, undefined, undefined, undefined, owner);
		if (!(await saving))
			throw new ProjectTransactionSessionError(
				"EDITOR_SYNC_PENDING",
				"The committed result could not be applied to the editor",
			);
		const receipt = useProjectStore.getState().lastTransactionReceipt;
		if (!receipt || receipt.requestId !== guard.requestId)
			throw new ProjectTransactionSessionError(
				"EDITOR_SYNC_PENDING",
				"Transaction receipt is not available",
			);
		recoveredUndoRequests.add(`${projectId}:${guard.requestId}`);
		return receipt;
	} finally {
		updateProject({}, [{ type: "finish", owner }]);
	}
}

// A queue may advance CAS only through writes whose exact committed snapshots
// this renderer received. External transactions never enter this lineage.
const localCommitLineage = new Map<
	string,
	{
		version: AiEditionProjectVersion;
		document: AxcutDocument;
		ancestors: string[];
	}
>();
function versionKey(version: AiEditionProjectVersion): string {
	return JSON.stringify([version.mutationIdentity, version.revision, version.fileHash]);
}
function equalJson(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}
/** Carry untouched fields forward from earlier queued saves. A later scalar edit
 * is intentional; concurrent structural array replacements need explicit review. */
function rebaseLocalDocument(base: unknown, candidate: unknown, committed: unknown): unknown {
	if (equalJson(candidate, base)) return committed;
	if (equalJson(committed, base) || equalJson(candidate, committed)) return candidate;
	if (Array.isArray(candidate) || Array.isArray(committed) || Array.isArray(base))
		throw new ProjectTransactionSessionError(
			"CONFLICT",
			"Concurrent structural edits need review; newer local changes were retained",
		);
	if (
		base &&
		candidate &&
		committed &&
		typeof base === "object" &&
		typeof candidate === "object" &&
		typeof committed === "object"
	) {
		const before = base as Record<string, unknown>;
		const next = candidate as Record<string, unknown>;
		const saved = committed as Record<string, unknown>;
		const keys = new Set([...Object.keys(before), ...Object.keys(next), ...Object.keys(saved)]);
		return Object.fromEntries(
			[...keys]
				.map((key) => [key, rebaseLocalDocument(before[key], next[key], saved[key])])
				.filter(([, value]) => value !== undefined),
		);
	}
	return candidate;
}

function retainSupersedingLocalEdit(parsed: AxcutDocument, base: AxcutDocument | null) {
	const current = useProjectStore.getState();
	if (!current.transactionVersion || current.projectId !== parsed.project.id) return;
	// The next queued save rebases its own intent. Do not publish this older
	// snapshot over its candidate or turn a known successful write into a barrier.
	if (activity.queued(parsed.project.id) > 0 || !base || !current.document) {
		updateProject({}, [{ type: "draft", kind: "dirty" }]);
		return;
	}
	try {
		const document = parseDocument(rebaseLocalDocument(base, current.document, parsed));
		updateProject(
			{
				document,
				revision: current.revision + 1,
			},
			[
				{
					type: "view",
					view: { kind: useProjectStore.getState().lifecycle.view.kind, error: null },
				},
				{ type: "draft", kind: "dirty" },
			],
		);
	} catch (error) {
		// Both structures contain edits. Preserve the live document and stop
		// automatic replacement until the actual conflict has been reviewed.
		updateProject({}, [
			{
				type: "view",
				view: {
					kind: useProjectStore.getState().lifecycle.view.kind,
					error: error instanceof Error ? error.message : String(error),
				},
			},
			{ type: "draft", kind: "dirty" },
			{ type: "block" },
		]);
	}
}

// Keep the earliest unsaved publication base across gesture frames. A scheduled
// save becomes the next checkpoint. References stay immutable; clone only at save.

function persistDocument(
	document: AxcutDocument,
	agentHistory?: AiEditionWriteGuard["agentHistory"],
	requestId?: string,
	externalGuard?: AiEditionWriteGuard,
): Promise<AxcutDocument> {
	const state = useProjectStore.getState();
	const epoch = state.lifecycle.epoch;
	// Capture the editor base and explicit external guard before joining the queue.
	// Only proven earlier local commits may rebase an ordinary queued edit.
	const external = externalGuard !== undefined;
	const published = state.document !== null && equalJson(document, state.document);
	const checkpoint = draftBase();
	const baseDocument =
		published && checkpoint?.document === state.document ? checkpoint.before : state.document;
	const base = baseDocument ? structuredClone(baseDocument) : null;
	if (!external && published && state.document)
		updateProject({}, [{ type: "checkpoint", document: state.document }]);
	const guard: AiEditionWriteGuard | null =
		externalGuard ??
		(state.projectId === document.project.id && state.transactionVersion
			? {
					requestId: requestId ?? crypto.randomUUID(),
					expected: { ...state.transactionVersion },
					...(agentHistory ? { agentHistory, recordUndo: true } : {}),
				}
			: null);
	let candidate = guard ? structuredClone(document) : document;
	const queueToken = Symbol("queued-save");
	if (guard && !external)
		activity.transition(document.project.id, { type: "queue", token: queueToken });

	const operation = persistQueue.then(async () => {
		if (!guard) {
			const result = await nativeBridgeClient.aiEdition.save(candidate);
			if (!result.success || !result.document)
				throw new Error(result.error ?? "Failed to save project");
			return parseDocument(result.document);
		}
		try {
			if (
				!external &&
				localRequest()?.projectId === document.project.id &&
				useProjectStore.getState().transactionSyncPending
			)
				throw new ProjectTransactionSessionError(
					"EDITOR_SYNC_PENDING",
					"Recover the previous local save receipt before another write",
				);
			const prior = localCommitLineage.get(document.project.id);
			if (
				!external &&
				prior &&
				!sameVersion(guard.expected, prior.version) &&
				prior.ancestors.includes(versionKey(guard.expected))
			) {
				const current = useProjectStore.getState();
				if (
					!base ||
					!prior.ancestors.includes(versionKey(guard.expected)) ||
					!sameVersion(current.transactionVersion, prior.version)
				)
					throw new ProjectTransactionSessionError(
						"CONFLICT",
						"Queued save no longer has a known local base",
					);
				try {
					candidate = parseDocument(rebaseLocalDocument(base, candidate, prior.document));
				} catch (error) {
					// An unpublished rejected replacement must not leave the editor
					// behind its known committed base: a later autosave could erase it.
					if (current.document && equalJson(current.document, base)) {
						updateProject({ document: prior.document, revision: current.revision + 1 });
					} else {
						// Both structures contain real edits. Retain the live version
						// and require conflict review before another full replacement.
						updateProject({}, [{ type: "block" }]);
					}
					throw error;
				}
				guard.expected = { ...prior.version };
			}
			if (!external)
				updateProject({}, [
					{
						type: "local-request",
						request: {
							kind: "local",
							projectId: document.project.id,
							requestId: guard.requestId,
							expected: { ...guard.expected },
							candidate,
							base,
						},
					},
				]);
			const result = await nativeBridgeClient.aiEdition.commit(
				document.project.id,
				candidate,
				guard,
			);
			if (!result.success)
				throw new ProjectTransactionSessionError(
					result.errorCode ?? "EXECUTION_FAILED",
					result.error ?? "Guarded save failed",
				);
			if (
				!result.receipt ||
				!result.document ||
				!result.version ||
				!result.snapshotMatchesReceipt ||
				result.receipt.requestId !== guard.requestId ||
				result.version.revision !== result.receipt.revision
			) {
				if (
					useProjectStore.getState().projectId === document.project.id &&
					useProjectStore.getState().lifecycle.epoch === epoch
				)
					updateProject(
						{
							lastTransactionReceipt: result.receipt ?? null,
						},
						[{ type: "block" }],
					);
				throw new ProjectTransactionSessionError(
					"EDITOR_SYNC_PENDING",
					"Commit succeeded but its exact editor snapshot is unavailable",
				);
			}
			const parsed = parseDocument(result.document);
			if (localRequest()?.requestId === guard.requestId)
				updateProject({}, [
					{ type: "request-confirmed", requestId: localRequest()?.requestId ?? "" },
				]);

			if (external) localCommitLineage.delete(document.project.id);
			else
				localCommitLineage.set(document.project.id, {
					version: result.version,
					document: parsed,
					ancestors: [
						...(prior && sameVersion(guard.expected, prior.version) ? prior.ancestors : []),
						versionKey(guard.expected),
					].slice(-64),
				});
			if (
				useProjectStore.getState().projectId === document.project.id &&
				useProjectStore.getState().lifecycle.epoch === epoch
			)
				updateProject({
					transactionVersion: result.version,
					lastTransactionReceipt: result.receipt,
				});
			return parsed;
		} catch (error) {
			if (
				error instanceof ProjectTransactionSessionError &&
				error.code === "CONFLICT" &&
				localRequest()?.requestId === guard.requestId
			)
				updateProject({}, [
					{ type: "request-confirmed", requestId: localRequest()?.requestId ?? "" },
				]);
			if (
				useProjectStore.getState().projectId === document.project.id &&
				useProjectStore.getState().lifecycle.epoch === epoch
			)
				updateProject({}, [
					{
						type: "view",
						view: {
							kind: useProjectStore.getState().lifecycle.view.kind,
							error: error instanceof Error ? error.message : String(error),
						},
					},
					{ type: "draft", kind: "dirty" },
					...(error instanceof ProjectTransactionSessionError && error.code === "CONFLICT"
						? []
						: [{ type: "block" } satisfies ProjectEvent]),
				]);
			throw error;
		}
	});
	persistQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation.finally(() => {
		if (guard && !external)
			activity.transition(document.project.id, { type: "dequeue", token: queueToken });
	});
}

type ProjectMutationLease = { operation: number; finish: () => void };

function beginTrackedProjectMutation(projectId: string): ProjectMutationLease {
	const operation = activity.begin(projectId);
	return {
		operation,
		finish: () => {
			activity.transition(projectId, { type: "finish", operation });
		},
	};
}
function beginSave(document: AxcutDocument) {
	return beginTrackedProjectMutation(document.project.id);
}
export function getProjectMutationGeneration(projectId: string): number {
	return activity.generation(projectId);
}
export async function waitForProjectMutations(projectId: string): Promise<void> {
	while (activity.active(projectId))
		await new Promise<void>((resolve) => {
			activity.transition(projectId, { type: "wait", resolve });
		});
}

async function loadProjectRequest(
	get: () => ProjectState,
	projectId: string | null,
	request: () => ReturnType<typeof nativeBridgeClient.aiEdition.get>,
	options?: { canApply: () => boolean },
): Promise<void> {
	if (options && !options.canApply()) return;
	if (isProjectTransactionBlocked())
		throw new ProjectTransactionSessionError(
			"EDITOR_BUSY",
			"Transaction reconciliation is pending",
		);
	const initial = get();
	if (initial.projectId && initial.transactionVersion && activity.queued(initial.projectId))
		throw new ProjectTransactionSessionError(
			"EDITOR_BUSY",
			"Wait for the guarded save receipt before changing projects",
		);
	updateProject({}, [{ type: "load" }]);
	const loadGeneration = get().lifecycle.epoch;
	const ownsPendingLoad = () => {
		const current = get();
		return (
			current.lifecycle.epoch === loadGeneration &&
			current.projectId === initial.projectId &&
			current.document === initial.document &&
			current.revision === initial.revision &&
			current.status === "loading" &&
			current.error === null
		);
	};
	const discardStaleLoad = () => {
		if ((!options || options.canApply()) && ownsPendingLoad()) return false;
		if (get().lifecycle.epoch === loadGeneration && get().lifecycle.view.kind === "loading")
			updateProject({}, [
				{
					type: "cancel-load",
					epoch: loadGeneration,
					diagnostic: ownsPendingLoad() ? "previous" : "current",
				},
			]);
		else console.warn("[project-lifecycle] Rejected stale load completion");
		return true;
	};
	const currentProjectId = initial.projectId;
	const currentMutation = currentProjectId
		? beginTrackedProjectMutation(currentProjectId)
		: undefined;
	try {
		const result = await request();
		if (discardStaleLoad()) return;
		if (projectId === null && result.success && !result.document) {
			if (ownsPendingLoad())
				updateProject({}, [
					{ type: "view", view: { kind: initial.document ? "ready" : "idle", error: null } },
				]);
			return;
		}
		if (!result.success || !result.document) {
			throw new Error(result.error ?? "Failed to load project");
		}
		const document = parseDocument(result.document);
		if (discardStaleLoad()) return;
		const loadedProjectId = projectId ?? document.project.id;
		updateProject(
			{
				projectId: loadedProjectId,
				transactionVersion: result.transactionVersion ?? null,
				lastTransactionReceipt: null,
				document,
				revision: get().revision + 1,
				lastSavedAt: new Date(),
			},
			[
				{ type: "view", view: { kind: "ready", error: null } },
				{ type: "draft", kind: "clean" },
			],
		);
		clearDocumentHistory();
		recoveredUndoRequests.clear();
		if (
			result.transactionVersion &&
			result.undoRecovery?.afterRevision === result.transactionVersion.revision
		)
			restoreRecoveryUndo(loadedProjectId, result.undoRecovery);
	} catch (error) {
		if (discardStaleLoad()) return;
		updateProject({}, [
			{
				type: "view",
				view: { kind: "error", error: error instanceof Error ? error.message : String(error) },
			},
		]);
	} finally {
		currentMutation?.finish();
	}
}

export const useProjectStore = create<ProjectState>((_set, get) =>
	projectSnapshot({
		lifecycle: initialProjectLifecycle(),
		projectId: null,
		document: null,
		revision: 0,
		transactionVersion: null,
		lastTransactionReceipt: null,
		sourceDurationSec: 0,
		currentTimeSec: 0,
		playing: false,
		lastSavedAt: null,

		async loadProject(projectId, options) {
			return loadProjectRequest(
				get,
				projectId,
				() => nativeBridgeClient.aiEdition.get(projectId),
				options,
			);
		},

		async loadLatestProject(options) {
			return loadProjectRequest(get, null, () => nativeBridgeClient.aiEdition.getLatest(), options);
		},

		async createProject(title) {
			if (
				isProjectTransactionBlocked() ||
				(get().projectId && get().transactionVersion && activity.queued(get().projectId ?? ""))
			)
				throw new ProjectTransactionSessionError(
					"EDITOR_BUSY",
					"Transaction reconciliation is pending",
				);
			updateProject({}, [{ type: "load" }]);
			const loadGeneration = get().lifecycle.epoch;
			const currentProjectId = get().projectId;
			const currentMutation = currentProjectId
				? beginTrackedProjectMutation(currentProjectId)
				: undefined;
			try {
				const result = await nativeBridgeClient.aiEdition.create(title);
				if (!result.success || !result.document) {
					throw new Error(result.error ?? "Failed to create project");
				}
				const createdDocument = parseDocument(result.document);
				if (get().lifecycle.epoch !== loadGeneration) {
					console.warn("[project-lifecycle] Rejected stale create before persistence");
					return createdDocument;
				}
				let document = createdDocument;
				try {
					document = await persistDocument(
						applyNewProjectPreferences(createdDocument, loadEditingPreferences()),
					);
				} catch (error) {
					// The native create already persisted a valid project. Keep that
					// project open if the follow-up defaults save fails, so the user does
					// not get an invisible orphan that can only be found on disk.
					console.warn("[project] could not apply remembered editing settings:", error);
					void import("sonner").then(({ toast }) =>
						toast.error("The project opened, but its remembered settings could not be applied", {
							description: error instanceof Error ? error.message : String(error),
						}),
					);
				}
				if (get().lifecycle.epoch !== loadGeneration) {
					console.warn("[project-lifecycle] Rejected stale create completion");
					return document;
				}
				updateProject(
					{
						projectId: document.project.id,
						transactionVersion: null,
						lastTransactionReceipt: null,
						document,
						revision: get().revision + 1,
						lastSavedAt: new Date(),
					},
					[
						{ type: "view", view: { kind: "ready", error: null } },
						{ type: "draft", kind: "clean" },
					],
				);
				clearDocumentHistory();
				return document;
			} catch (error) {
				if (get().lifecycle.epoch !== loadGeneration) throw error;
				updateProject({}, [
					{
						type: "view",
						view: { kind: "error", error: error instanceof Error ? error.message : String(error) },
					},
				]);
				throw error;
			} finally {
				currentMutation?.finish();
			}
		},

		async refresh() {
			const { projectId } = get();
			if (!projectId) return;
			await get().loadProject(projectId);
		},

		async addAsset(path, label, options) {
			if (isProjectTransactionBlocked())
				throw new ProjectTransactionSessionError("BUSY", "The project is synchronizing");
			if (get().transactionVersion) return addGuardedAsset(path, label, options);

			const { projectId } = get();
			if (!projectId) throw new Error("No project loaded");
			const mutation = beginTrackedProjectMutation(projectId);
			const epoch = get().lifecycle.epoch;
			try {
				const result = options?.recordingImportId
					? await nativeBridgeClient.aiEdition.addAsset(
							projectId,
							path,
							label,
							options.recordingImportId,
						)
					: await nativeBridgeClient.aiEdition.addAsset(projectId, path, label);
				let document = parseDocument(result.document);
				if (get().lifecycle.epoch !== epoch) {
					console.warn("[project-lifecycle] Rejected stale asset completion");
					return null;
				}
				const newestAssetsFirst = [...document.assets].reverse();
				const addedAsset =
					(options?.recordingImportId
						? newestAssetsFirst.find(
								(asset) => asset.recordingImportId === options.recordingImportId,
							)
						: newestAssetsFirst.find(
								(asset) => asset.originalPath === path && (label ? asset.label === label : true),
							)) ??
					document.assets.at(-1) ??
					null;

				// P4 — auto-link the camera track from the recording-links registry (or
				// its legacy sidecar) for EVERY asset added, not just the first one in
				// the project: a project can hold multiple recordings, each with its
				// own camera (or none). The link is stored on the asset itself, not a
				// document-global field, so it follows the right clip in the timeline.
				// The camera DSL is read-only — cuts/zoom/speed live on the main
				// timeline and apply to the camera via the shared source-time
				// progression.
				if (addedAsset && window.electronAPI?.findRecordingCamera) {
					try {
						const camera = await window.electronAPI.findRecordingCamera(addedAsset.originalPath);
						if (get().lifecycle.epoch !== epoch) {
							console.warn("[project-lifecycle] Rejected stale camera completion");
							return null;
						}
						if (camera.success && camera.webcamVideoPath) {
							const linked = {
								sourcePath: camera.webcamVideoPath,
								startMs: 0,
								// ROUNDED, because `cameraTrackSchema` requires an integer and
								// the native capture paths measure this offset with
								// `performance.now()`, whose resolution is 100 µs — so roughly
								// nine recordings in ten produced something like -192.8 here.
								// `parseDocument` below then threw, the catch treated it as a
								// lookup failure, and the camera was dropped from a recording
								// that had one: the editor showed the screen video in the
								// camera's place. Sub-millisecond precision is meaningless for
								// a frame offset (a 60 fps frame is 16.7 ms), so rounding costs
								// nothing. Recordings already on disk carry the fractional
								// value in their session manifest, which is why this rounds on
								// the way IN rather than only at the recorder.
								offsetMs: Math.round(camera.offsetMs ?? 0),
								visible: true,
							};
							const next: AxcutDocument = {
								...document,
								assets: document.assets.map((a) =>
									a.id === addedAsset.id ? { ...a, cameraTrack: linked } : a,
								),
							};
							if (!(await get().saveDocument(next))) return null;
							document = parseDocument(next);
						}
						// success:false just means no camera was found for this asset —
						// the normal case for a plain imported video. Nothing to surface.
					} catch (err) {
						// An actual lookup failure (not "no camera found") — worth surfacing.
						// Logged as well as toasted: a toast is gone in five seconds, and the
						// symptom this produces (a recording that silently loses its camera)
						// is reported from the editor, long after.
						console.warn("[project] camera auto-link failed:", err);
						const name = addedAsset.originalPath.split(/[\\/]/).pop() ?? addedAsset.originalPath;
						void import("sonner").then(({ toast }) =>
							toast.error(`Could not check for a camera recording near ${name}`, {
								description: err instanceof Error ? err.message : String(err),
							}),
						);
					}
				}

				if (get().lifecycle.epoch !== epoch) {
					console.warn("[project-lifecycle] Rejected stale asset publication");
					return null;
				}
				updateProject(
					{
						document,
						revision: get().revision + 1,
						lastSavedAt: new Date(),
					},
					[{ type: "draft", kind: "clean" }],
				);
				// Camera auto-linking replaces the asset inside `document`. Return that
				// final asset so import-time analysis sees the camera track immediately.
				// Returning `addedAsset` here exposed the stale pre-link object even though
				// the saved project was correct.
				return addedAsset
					? (document.assets.find((asset) => asset.id === addedAsset.id) ?? addedAsset)
					: null;
			} finally {
				mutation.finish();
			}
		},

		async removeAsset(assetId) {
			if (isProjectTransactionBlocked())
				throw new ProjectTransactionSessionError("BUSY", "The project is synchronizing");
			if (get().transactionVersion) {
				const doc = get().document;
				if (!doc || !doc.assets.some((asset) => asset.id === assetId))
					throw new Error("Asset not found");
				if (!(await get().saveDocumentAsEdit(removeAssetFromDocument(doc, assetId))))
					throw new ProjectTransactionSessionError(
						"CONFLICT",
						"Asset removal was not synchronized",
					);
				return;
			}

			const { projectId } = get();
			if (!projectId) throw new Error("No project loaded");
			const mutation = beginTrackedProjectMutation(projectId);
			const epoch = get().lifecycle.epoch;
			try {
				const result = await nativeBridgeClient.aiEdition.removeAsset(projectId, assetId);
				const document = parseDocument(result.document);
				if (get().lifecycle.epoch !== epoch) {
					console.warn("[project-lifecycle] Rejected stale removal completion");
					return;
				}
				updateProject(
					{
						document,
						revision: get().revision + 1,
						lastSavedAt: new Date(),
					},
					[{ type: "draft", kind: "clean" }],
				);
			} finally {
				mutation.finish();
			}
		},

		async saveDocument(document) {
			if (isProjectTransactionBlocked()) return false;
			const epoch = get().lifecycle.epoch;
			const startingRevision = get().revision;
			const base = get().document;
			const mutation = beginSave(document);
			try {
				const parsed = await persistDocument(document);
				if (get().lifecycle.epoch !== epoch) {
					console.warn("[project-lifecycle] Rejected stale save completion");
					return false;
				}
				if (
					get().projectId !== parsed.project.id ||
					get().revision !== startingRevision ||
					activity.generation(parsed.project.id) !== mutation.operation
				) {
					retainSupersedingLocalEdit(parsed, base);
					return false;
				}
				updateProject(
					{
						document: parsed,
						revision: get().revision + 1,
						lastSavedAt: new Date(),
					},
					[
						{
							type: "view",
							view: { kind: useProjectStore.getState().lifecycle.view.kind, error: null },
						},
						{ type: "draft", kind: "clean" },
					],
				);
				return true;
			} finally {
				mutation.finish();
			}
		},

		async saveDocumentIfCurrent(document, guard) {
			const state = get();
			if (
				state.projectId !== document.project.id ||
				state.revision !== guard.revision ||
				getProjectMutationGeneration(document.project.id) !== guard.mutationGeneration
			) {
				return false;
			}
			// No await before saveDocument starts and reserves the next generation.
			// A user save cannot enter between this guard and that reservation.
			return state.saveDocument(document);
		},

		async saveDocumentAsEdit(document, historySnapshot, agentHistory, requestId) {
			return saveProjectEdit(document, historySnapshot, agentHistory, requestId);
		},

		async applyDocumentPatch(projectId, patch, options) {
			if (isProjectTransactionBlocked()) return "conflict";
			if (options?.agentHistory && !get().transactionVersion)
				await activateProjectTransactions(projectId);
			const maximumAttempts = Math.max(1, Math.floor(options?.maximumAttempts ?? 5));
			for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
				await waitForProjectMutations(projectId);
				if (isProjectTransactionBlocked()) return "conflict";
				const state = get();
				if (state.projectId !== projectId || !state.document) return "project-changed";
				const base = state.document;
				const next = patch(base);
				if (next === base) {
					if (options?.coalesceIntoHistory) patchDocumentHistory(projectId, patch);
					return "unchanged";
				}
				const historySnapshot = options?.createHistorySnapshot?.(base);
				const saved = historySnapshot
					? await state.saveDocumentAsEdit(
							next,
							historySnapshot,
							options?.agentHistory,
							options?.requestId,
						)
					: await state.saveDocumentIfCurrent(next, {
							revision: state.revision,
							mutationGeneration: getProjectMutationGeneration(projectId),
						});
				if (saved) {
					if (options?.normalizeHistorySnapshots) {
						patchDocumentHistory(projectId, options.normalizeHistorySnapshots);
					}
					if (options?.coalesceIntoHistory) patchDocumentHistory(projectId, patch);
					return "applied";
				}
				if (get().projectId !== projectId) return "project-changed";
			}
			return "conflict";
		},

		setDocument(document) {
			if (isProjectTransactionBlocked()) return;
			const prev = get().document;
			if (prev && prev !== document) {
				recordDocumentSnapshot(prev);
			}
			updateProject(
				{
					document,
					revision: get().revision + 1,
				},
				[{ type: "publish-draft", document, previous: prev }],
			);
		},

		setDocumentLive(document) {
			if (isProjectTransactionBlocked()) return;
			const prev = get().document;
			updateProject(
				{
					document,
					revision: get().revision + 1,
				},
				[{ type: "publish-draft", document, previous: prev }],
			);
		},

		restoreDocumentFromHistory(document) {
			if (isProjectTransactionBlocked()) return;
			const prev = get().document;
			updateProject(
				{
					document,
					revision: get().revision + 1,
				},
				[{ type: "publish-draft", document, previous: prev }],
			);
		},

		async replaceTimeline(intervals, reason) {
			const doc = get().document;
			if (!doc) throw new Error("No project loaded");
			const next = replaceTimelineOp(doc, intervals, reason);
			await get().saveDocument(next);
		},

		async restoreFullTimeline() {
			const doc = get().document;
			if (!doc) throw new Error("No project loaded");
			const next = restoreFullTimelineOp(doc);
			await get().saveDocument(next);
		},

		setSourceDuration(sec) {
			updateProject({ sourceDurationSec: sec });
		},

		setCurrentTime(sec) {
			updateProject({ currentTimeSec: sec });
		},

		setPlaying(playing) {
			updateProject({ playing });
		},

		clear() {
			if (get().projectId && get().transactionVersion && activity.queued(get().projectId ?? "")) {
				console.warn("[project-lifecycle] Rejected clearing a pending guarded save");
				return;
			}
			if (isProjectTransactionBlocked()) return;
			clearDocumentHistory();
			recoveredUndoRequests.clear();

			localCommitLineage.clear();
			updateProject(
				{
					projectId: null,
					document: null,
					revision: 0,
					transactionVersion: null,
					lastTransactionReceipt: null,
					sourceDurationSec: 0,
					currentTimeSec: 0,
					playing: false,
					lastSavedAt: null,
				},
				[{ type: "reset" }],
			);
		},

		markClean() {
			if (isProjectTransactionBlocked()) return;
			updateProject({ lastSavedAt: new Date() }, [{ type: "draft", kind: "clean" }]);
		},
	}),
);

/** File/camera preparation never publishes partial asset state. The original
 * revision must still be current when the complete edit enters the save queue. */
async function addGuardedAsset(
	path: string,
	label?: string,
	options?: { recordingImportId?: string },
): Promise<AxcutAsset | null> {
	const base = useProjectStore.getState();
	if (!base.document || !base.projectId) throw new Error("No project loaded");
	const mutation = beginTrackedProjectMutation(base.projectId);
	const generation = getProjectMutationGeneration(base.projectId);
	try {
		const prepared = await nativeBridgeClient.aiEdition.prepareAsset(
			base.projectId,
			path,
			label,
			options?.recordingImportId,
		);
		let asset = assetSchema.parse(prepared.asset);
		if (window.electronAPI?.findRecordingCamera) {
			const camera = await window.electronAPI.findRecordingCamera(asset.originalPath);
			if (camera.success && camera.webcamVideoPath)
				asset = assetSchema.parse({
					...asset,
					cameraTrack: {
						sourcePath: camera.webcamVideoPath,
						startMs: 0,
						offsetMs: Math.round(camera.offsetMs ?? 0),
						visible: true,
					},
				});
		}
		const current = useProjectStore.getState();
		if (
			current.projectId !== base.projectId ||
			current.lifecycle.epoch !== base.lifecycle.epoch ||
			current.revision !== base.revision ||
			getProjectMutationGeneration(base.projectId) !== generation ||
			isProjectTransactionBlocked()
		)
			throw new ProjectTransactionSessionError(
				"CONFLICT",
				"The project changed during media preparation. Try importing again.",
			);
		const next = {
			...base.document,
			assets: [...base.document.assets, asset],
			project: {
				...base.document.project,
				primaryAssetId: base.document.project.primaryAssetId ?? asset.id,
			},
		};
		// Recording insertion owns its combined assets/clips Undo snapshot.
		const saved = options?.recordingImportId
			? await current.saveDocument(next)
			: await current.saveDocumentAsEdit(next);
		if (!saved)
			throw new ProjectTransactionSessionError("CONFLICT", "Media import was not synchronized");
		return asset;
	} finally {
		mutation.finish();
	}
}

type ProjectData = Omit<
	ProjectState,
	"status" | "error" | "dirty" | "transactionBusy" | "transactionSyncPending"
>;
export function projectSnapshot(data: ProjectData): ProjectState {
	const lifecycle = data.lifecycle;
	return {
		...data,
		get status() {
			return lifecycle.view.kind;
		},
		get error() {
			return lifecycle.view.error;
		},
		get dirty() {
			return lifecycle.draft.kind === "dirty";
		},
		get transactionBusy() {
			return projectBusy(lifecycle);
		},
		get transactionSyncPending() {
			return projectSyncPending(lifecycle);
		},
	};
}
function updateProject(data: Partial<ProjectData>, events: ProjectEvent[] = []) {
	const current = useProjectStore.getState();
	const lifecycle = events.reduce(transitionProject, current.lifecycle);
	useProjectStore.setState(projectSnapshot({ ...current, ...data, lifecycle }), true);
}

async function saveProjectEdit(
	document: AxcutDocument,
	historySnapshot?: AxcutDocument,
	agentHistory?: AiEditionWriteGuard["agentHistory"],
	requestId?: string,
	owner?: symbol,
): Promise<boolean> {
	const editing = useProjectStore.getState().lifecycle.editing;
	const externalGuard =
		owner !== undefined && editing.kind === "external" && editing.owner === owner
			? editing.request.guard
			: undefined;
	if (owner !== undefined && !externalGuard) {
		console.warn("[project-lifecycle] Rejected unowned external save");
		return false;
	}
	if (!externalGuard && isProjectTransactionBlocked()) {
		console.warn("[project-lifecycle] Rejected edit while recovery is pending");
		return false;
	}

	const epoch = useProjectStore.getState().lifecycle.epoch;
	const startingRevision = useProjectStore.getState().revision;
	const base = useProjectStore.getState().document;
	const mutation = beginSave(document);
	const previous = historySnapshot ?? useProjectStore.getState().document;
	try {
		const parsed = await persistDocument(document, agentHistory, requestId, externalGuard);
		if (useProjectStore.getState().lifecycle.epoch !== epoch) {
			console.warn("[project-lifecycle] Rejected stale edit completion");
			return false;
		}
		if (
			useProjectStore.getState().projectId !== parsed.project.id ||
			useProjectStore.getState().revision !== startingRevision ||
			activity.generation(parsed.project.id) !== mutation.operation
		) {
			retainSupersedingLocalEdit(parsed, base);
			return false;
		}
		// Record only after persistence succeeds, but before publishing the new
		// document. Undo can therefore never expose a failed save as a real edit.
		if (previous && previous !== document && previous.project.id === parsed.project.id) {
			recordDocumentSnapshot(previous);
		}
		updateProject(
			{
				document: parsed,
				revision: useProjectStore.getState().revision + 1,
				lastSavedAt: new Date(),
			},
			[
				{
					type: "view",
					view: { kind: useProjectStore.getState().lifecycle.view.kind, error: null },
				},
				{ type: "draft", kind: "clean" },
			],
		);
		return true;
	} finally {
		mutation.finish();
	}
}

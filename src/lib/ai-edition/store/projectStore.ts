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

// ponytail: thin Zustand wrapper over the native-bridge client. Keeps the
// current project + revision counter in renderer memory; mutations round-trip
// through the main process via the bridge so disk state stays authoritative.

type ProjectStatus = "idle" | "loading" | "ready" | "error";
type DocumentPatchResult = "applied" | "unchanged" | "project-changed" | "conflict";
type ProjectDocumentPatch = (document: AxcutDocument) => AxcutDocument;

export interface ProjectState {
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
let mutationSequence = 0;
let projectLoadGeneration = 0;
const latestMutationByProject = new Map<string, number>();
const activeMutationCountByProject = new Map<string, number>();
const idleWaitersByProject = new Map<string, Array<() => void>>();

class ProjectTransactionSessionError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}
let externalSaveGuard: AiEditionWriteGuard | null = null;
let pendingExternalRequest: { projectId: string; requestId: string } | null = null;
let pendingLocalRequest: {
	projectId: string;
	requestId: string;
	expected: AiEditionProjectVersion;
	candidate: AxcutDocument;
	base: AxcutDocument | null;
} | null = null;
let recoveryCopy: { projectId: string; revision: number; copyId: string } | null = null;
const queuedLocalSaves = new Map<string, number>();

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
	if (pendingExternalRequest?.projectId !== projectId)
		throw new ProjectTransactionSessionError(
			"LOCAL_RECONCILIATION_REQUIRED",
			"Local edits need explicit conflict recovery",
		);
	const requestId = pendingExternalRequest.requestId;
	const snapshot = await nativeBridgeClient.aiEdition.snapshot(projectId);
	const current = useProjectStore.getState();
	if (current.projectId !== projectId || current.revision !== before.revision)
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
		useProjectStore.setState({ transactionSyncPending: false, dirty: false, error: null });
		pendingExternalRequest = null;
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
	useProjectStore.setState({
		document,
		transactionVersion: snapshot.version,
		revision: current.revision + 1,
		dirty: false,
		transactionSyncPending: false,
		error: null,
		lastSavedAt: new Date(),
	});
	pendingExternalRequest = null;
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
	if (pendingExternalRequest?.projectId === projectId)
		throw new ProjectTransactionSessionError(
			"EXTERNAL_RECONCILIATION_REQUIRED",
			"Reconcile the external transaction receipt before choosing local recovery",
		);
	if (before.transactionBusy || (activeMutationCountByProject.get(projectId) ?? 0) > 0)
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
		if (current.projectId !== projectId || current.revision !== before.revision)
			throw new ProjectTransactionSessionError("PROJECT_CHANGED", "Editor changed during recovery");
	};
	useProjectStore.setState({ transactionBusy: true });
	try {
		const pending = pendingLocalRequest?.projectId === projectId ? pendingLocalRequest : null;
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
			if (recoveryCopy?.projectId === projectId && recoveryCopy.revision === before.revision) {
				targetId = recoveryCopy.copyId;
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
				recoveryCopy = { projectId, revision: before.revision, copyId: targetId };
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
		useProjectStore.setState({
			projectId: targetId,
			document,
			revision: before.revision + 1,
			transactionVersion: loaded.transactionVersion ?? null,
			lastTransactionReceipt: null,
			transactionSyncPending: false,
			dirty: false,
			status: "ready",
			error: null,
			lastSavedAt: new Date(),
			playing: false,
		});
		if (
			loaded.transactionVersion &&
			loaded.undoRecovery?.afterRevision === loaded.transactionVersion.revision
		)
			restoreRecoveryUndo(targetId, loaded.undoRecovery);
		pendingLocalRequest = null;
		recoveryCopy = null;
		return { projectId: targetId, strategy };
	} catch (error) {
		if (useProjectStore.getState().projectId === projectId)
			useProjectStore.setState({
				dirty: true,
				transactionSyncPending: true,
				error: error instanceof Error ? error.message : String(error),
			});
		throw error;
	} finally {
		useProjectStore.setState({ transactionBusy: false });
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
	if (
		state.dirty ||
		isProjectTransactionBlocked() ||
		(activeMutationCountByProject.get(projectId) ?? 0) > 0
	)
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
	useProjectStore.setState({ transactionVersion: result.version, lastTransactionReceipt: null });
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
	useProjectStore.setState({ transactionBusy: true });
	try {
		externalSaveGuard = { ...guard, recordUndo: true };
		pendingExternalRequest = { projectId, requestId: guard.requestId };
		const saving = state.saveDocumentAsEdit(document);
		externalSaveGuard = null;
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
		pendingExternalRequest = null;
		return receipt;
	} finally {
		externalSaveGuard = null;
		useProjectStore.setState({ transactionBusy: false });
		if (!useProjectStore.getState().transactionSyncPending) pendingExternalRequest = null;
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
	if ((queuedLocalSaves.get(parsed.project.id) ?? 0) > 0 || !base || !current.document) {
		useProjectStore.setState({ dirty: true });
		return;
	}
	try {
		const document = parseDocument(rebaseLocalDocument(base, current.document, parsed));
		useProjectStore.setState({
			document,
			revision: current.revision + 1,
			dirty: true,
			error: null,
		});
	} catch (error) {
		// Both structures contain edits. Preserve the live document and stop
		// automatic replacement until the actual conflict has been reviewed.
		useProjectStore.setState({
			transactionSyncPending: true,
			dirty: true,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// Keep the earliest unsaved publication base across gesture frames. A scheduled
// save becomes the next checkpoint. References stay immutable; clone only at save.
let publishedDraftBase: { document: AxcutDocument; before: AxcutDocument } | null = null;
function trackPublishedDraft(document: AxcutDocument, previous: AxcutDocument | null) {
	publishedDraftBase = previous
		? {
				document,
				before: publishedDraftBase?.document === previous ? publishedDraftBase.before : previous,
			}
		: null;
}

function persistDocument(
	document: AxcutDocument,
	agentHistory?: AiEditionWriteGuard["agentHistory"],
	requestId?: string,
): Promise<AxcutDocument> {
	const state = useProjectStore.getState();
	// Capture the editor base and explicit external guard before joining the queue.
	// Only proven earlier local commits may rebase an ordinary queued edit.
	const external = externalSaveGuard !== null;
	const published = state.document !== null && equalJson(document, state.document);
	const baseDocument =
		published && publishedDraftBase?.document === state.document
			? publishedDraftBase.before
			: state.document;
	const base = baseDocument ? structuredClone(baseDocument) : null;
	if (!external && published && state.document)
		publishedDraftBase = { document: state.document, before: state.document };
	const guard: AiEditionWriteGuard | null =
		externalSaveGuard ??
		(state.projectId === document.project.id && state.transactionVersion
			? {
					requestId: requestId ?? crypto.randomUUID(),
					expected: { ...state.transactionVersion },
					...(agentHistory ? { agentHistory, recordUndo: true } : {}),
				}
			: null);
	let candidate = guard ? structuredClone(document) : document;
	if (guard && !external)
		queuedLocalSaves.set(document.project.id, (queuedLocalSaves.get(document.project.id) ?? 0) + 1);

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
				pendingLocalRequest?.projectId === document.project.id &&
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
						useProjectStore.setState({ document: prior.document, revision: current.revision + 1 });
					} else {
						// Both structures contain real edits. Retain the live version
						// and require conflict review before another full replacement.
						useProjectStore.setState({ transactionSyncPending: true });
					}
					throw error;
				}
				guard.expected = { ...prior.version };
			}
			if (!external)
				pendingLocalRequest = {
					projectId: document.project.id,
					requestId: guard.requestId,
					expected: { ...guard.expected },
					candidate,
					base,
				};
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
				if (useProjectStore.getState().projectId === document.project.id)
					useProjectStore.setState({
						transactionSyncPending: true,
						lastTransactionReceipt: result.receipt ?? null,
					});
				throw new ProjectTransactionSessionError(
					"EDITOR_SYNC_PENDING",
					"Commit succeeded but its exact editor snapshot is unavailable",
				);
			}
			const parsed = parseDocument(result.document);
			if (pendingLocalRequest?.requestId === guard.requestId) pendingLocalRequest = null;

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
			if (useProjectStore.getState().projectId === document.project.id)
				useProjectStore.setState({
					transactionVersion: result.version,
					lastTransactionReceipt: result.receipt,
				});
			return parsed;
		} catch (error) {
			if (
				error instanceof ProjectTransactionSessionError &&
				error.code === "CONFLICT" &&
				pendingLocalRequest?.requestId === guard.requestId
			)
				pendingLocalRequest = null;
			if (useProjectStore.getState().projectId === document.project.id)
				useProjectStore.setState({
					dirty: true,
					error: error instanceof Error ? error.message : String(error),
					...(error instanceof ProjectTransactionSessionError && error.code === "CONFLICT"
						? {}
						: { transactionSyncPending: true }),
				});
			throw error;
		}
	});
	persistQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation.finally(() => {
		if (guard && !external) {
			const count = (queuedLocalSaves.get(document.project.id) ?? 1) - 1;
			if (count > 0) queuedLocalSaves.set(document.project.id, count);
			else queuedLocalSaves.delete(document.project.id);
		}
	});
}

type ProjectMutationLease = { operation: number; finish: () => void };

function beginTrackedProjectMutation(projectId: string): ProjectMutationLease {
	const operation = beginProjectMutation(projectId);
	activeMutationCountByProject.set(
		projectId,
		(activeMutationCountByProject.get(projectId) ?? 0) + 1,
	);
	let finished = false;
	return {
		operation,
		finish: () => {
			if (finished) return;
			finished = true;
			const remaining = Math.max(0, (activeMutationCountByProject.get(projectId) ?? 1) - 1);
			if (remaining > 0) {
				activeMutationCountByProject.set(projectId, remaining);
				return;
			}
			activeMutationCountByProject.delete(projectId);
			for (const resolve of idleWaitersByProject.get(projectId) ?? []) resolve();
			idleWaitersByProject.delete(projectId);
		},
	};
}

function beginSave(document: AxcutDocument): ProjectMutationLease {
	return beginTrackedProjectMutation(document.project.id);
}

function beginProjectMutation(projectId: string): number {
	const operation = ++mutationSequence;
	latestMutationByProject.set(projectId, operation);
	return operation;
}

/** Synchronous generation used to detect document work that started but has not published yet. */
export function getProjectMutationGeneration(projectId: string): number {
	return latestMutationByProject.get(projectId) ?? 0;
}

export async function waitForProjectMutations(projectId: string): Promise<void> {
	while ((activeMutationCountByProject.get(projectId) ?? 0) > 0) {
		await new Promise<void>((resolve) => {
			const waiters = idleWaitersByProject.get(projectId) ?? [];
			waiters.push(resolve);
			idleWaitersByProject.set(projectId, waiters);
		});
	}
}

async function loadProjectRequest(
	get: () => ProjectState,
	set: (partial: Partial<ProjectState>) => void,
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
	const loadGeneration = ++projectLoadGeneration;
	const ownsPendingLoad = () => {
		const current = get();
		return (
			projectLoadGeneration === loadGeneration &&
			current.projectId === initial.projectId &&
			current.document === initial.document &&
			current.revision === initial.revision &&
			current.status === "loading" &&
			current.error === null
		);
	};
	const discardStaleLoad = () => {
		if (!options || (options.canApply() && ownsPendingLoad())) return false;
		if (ownsPendingLoad()) set({ status: initial.status, error: initial.error });
		return true;
	};
	const currentProjectId = initial.projectId;
	const currentMutation = currentProjectId
		? beginTrackedProjectMutation(currentProjectId)
		: undefined;
	try {
		set({ status: "loading", error: null });
		const result = await request();
		if (discardStaleLoad()) return;
		if (projectId === null && result.success && !result.document) {
			if (ownsPendingLoad()) set({ status: initial.document ? "ready" : "idle", error: null });
			return;
		}
		if (!result.success || !result.document) {
			throw new Error(result.error ?? "Failed to load project");
		}
		const document = parseDocument(result.document);
		if (discardStaleLoad()) return;
		const loadedProjectId = projectId ?? document.project.id;
		set({
			projectId: loadedProjectId,
			transactionVersion: result.transactionVersion ?? null,
			lastTransactionReceipt: null,
			document,
			revision: get().revision + 1,
			status: "ready",
			error: null,
			dirty: false,
			lastSavedAt: new Date(),
		});
		clearDocumentHistory();
		recoveredUndoRequests.clear();
		if (
			result.transactionVersion &&
			result.undoRecovery?.afterRevision === result.transactionVersion.revision
		)
			restoreRecoveryUndo(loadedProjectId, result.undoRecovery);
	} catch (error) {
		if (discardStaleLoad()) return;
		set({
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		currentMutation?.finish();
	}
}

export const useProjectStore = create<ProjectState>((set, get) => ({
	projectId: null,
	document: null,
	revision: 0,
	transactionVersion: null,
	transactionBusy: false,
	transactionSyncPending: false,
	lastTransactionReceipt: null,
	status: "idle",
	error: null,
	sourceDurationSec: 0,
	currentTimeSec: 0,
	playing: false,
	dirty: false,
	lastSavedAt: null,

	async loadProject(projectId, options) {
		return loadProjectRequest(
			get,
			set,
			projectId,
			() => nativeBridgeClient.aiEdition.get(projectId),
			options,
		);
	},

	async loadLatestProject(options) {
		return loadProjectRequest(
			get,
			set,
			null,
			() => nativeBridgeClient.aiEdition.getLatest(),
			options,
		);
	},

	async createProject(title) {
		if (isProjectTransactionBlocked())
			throw new ProjectTransactionSessionError(
				"EDITOR_BUSY",
				"Transaction reconciliation is pending",
			);
		projectLoadGeneration += 1;
		const currentProjectId = get().projectId;
		const currentMutation = currentProjectId
			? beginTrackedProjectMutation(currentProjectId)
			: undefined;
		set({ status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.create(title);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to create project");
			}
			const createdDocument = parseDocument(result.document);
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
			set({
				projectId: document.project.id,
				transactionVersion: null,
				lastTransactionReceipt: null,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			clearDocumentHistory();
			return document;
		} catch (error) {
			set({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
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
			const newestAssetsFirst = [...document.assets].reverse();
			const addedAsset =
				(options?.recordingImportId
					? newestAssetsFirst.find((asset) => asset.recordingImportId === options.recordingImportId)
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
						await get().saveDocument(next);
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

			set({
				document,
				revision: get().revision + 1,
				dirty: false,
				lastSavedAt: new Date(),
			});
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
				throw new ProjectTransactionSessionError("CONFLICT", "Asset removal was not synchronized");
			return;
		}

		const { projectId } = get();
		if (!projectId) throw new Error("No project loaded");
		const mutation = beginTrackedProjectMutation(projectId);
		try {
			const result = await nativeBridgeClient.aiEdition.removeAsset(projectId, assetId);
			const document = parseDocument(result.document);
			set({
				document,
				revision: get().revision + 1,
				dirty: false,
				lastSavedAt: new Date(),
			});
		} finally {
			mutation.finish();
		}
	},

	async saveDocument(document) {
		if (isProjectTransactionBlocked()) return false;
		const startingRevision = get().revision;
		const base = get().document;
		const mutation = beginSave(document);
		try {
			const parsed = await persistDocument(document);
			if (
				get().projectId !== parsed.project.id ||
				get().revision !== startingRevision ||
				latestMutationByProject.get(parsed.project.id) !== mutation.operation
			) {
				retainSupersedingLocalEdit(parsed, base);
				return false;
			}
			set({
				document: parsed,
				revision: get().revision + 1,
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
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
		if (isProjectTransactionBlocked() && !externalSaveGuard) return false;
		const startingRevision = get().revision;
		const base = get().document;
		const mutation = beginSave(document);
		const previous = historySnapshot ?? get().document;
		try {
			const parsed = await persistDocument(document, agentHistory, requestId);
			if (
				get().projectId !== parsed.project.id ||
				get().revision !== startingRevision ||
				latestMutationByProject.get(parsed.project.id) !== mutation.operation
			) {
				retainSupersedingLocalEdit(parsed, base);
				return false;
			}
			// Record only after persistence succeeds, but before publishing the new
			// document. Undo can therefore never expose a failed save as a real edit.
			if (previous && previous !== document && previous.project.id === parsed.project.id) {
				recordDocumentSnapshot(previous);
			}
			set({
				document: parsed,
				revision: get().revision + 1,
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			return true;
		} finally {
			mutation.finish();
		}
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
		trackPublishedDraft(document, prev);
		if (prev && prev !== document) {
			recordDocumentSnapshot(prev);
		}
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
	},

	setDocumentLive(document) {
		if (isProjectTransactionBlocked()) return;
		trackPublishedDraft(document, get().document);
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
	},

	restoreDocumentFromHistory(document) {
		if (isProjectTransactionBlocked()) return;
		trackPublishedDraft(document, get().document);
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
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
		set({ sourceDurationSec: sec });
	},

	setCurrentTime(sec) {
		set({ currentTimeSec: sec });
	},

	setPlaying(playing) {
		set({ playing });
	},

	clear() {
		if (isProjectTransactionBlocked()) return;
		clearDocumentHistory();
		recoveredUndoRequests.clear();
		pendingExternalRequest = null;
		localCommitLineage.clear();
		publishedDraftBase = null;
		pendingLocalRequest = null;
		recoveryCopy = null;
		set({
			projectId: null,
			document: null,
			revision: 0,
			transactionVersion: null,
			transactionBusy: false,
			transactionSyncPending: false,
			lastTransactionReceipt: null,
			status: "idle",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
			playing: false,
			dirty: false,
			lastSavedAt: null,
		});
	},

	markClean() {
		if (isProjectTransactionBlocked()) return;
		set({ dirty: false, lastSavedAt: new Date() });
	},
}));

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

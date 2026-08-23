import { create } from "zustand";
import { requireEntitlement } from "@/lib/entitlements/store";
import { nativeBridgeClient } from "@/native/client";
import {
	type Interval,
	replaceTimeline as replaceTimelineOp,
	restoreFullTimeline as restoreFullTimelineOp,
} from "../document/timeline";
import { type AxcutAsset, type AxcutDocument, documentSchema } from "../schema";
import {
	clearDocumentHistory,
	patchDocumentHistory,
	recordDocumentSnapshot,
} from "./documentHistory";
import { applyEditingDefaultPreferences, loadEditingPreferences } from "./editingPreferences";

// ponytail: thin Zustand wrapper over the native-bridge client. Keeps the
// current project + revision counter in renderer memory; mutations round-trip
// through the main process via the bridge so disk state stays authoritative.

export type ProjectStatus = "idle" | "loading" | "ready" | "error";
export type DocumentPatchResult = "applied" | "unchanged" | "project-changed" | "conflict";
export type ProjectDocumentPatch = (document: AxcutDocument) => AxcutDocument;

export interface ProjectState {
	projectId: string | null;
	document: AxcutDocument | null;
	revision: number;
	status: ProjectStatus;
	error: string | null;
	sourceDurationSec: number;
	currentTimeSec: number;
	/** Single source of truth for "is the timeline transport playing?" — previously
	 *  duplicated as separate local state in NewEditorShell AND VirtualPreview, each
	 *  independently wired to the same raw <video> DOM events, which let one advance
	 *  a clip boundary while the other unconditionally stopped playback. */
	playing: boolean;
	/** True when the in-memory document has local changes that haven't been written to disk yet. */
	dirty: boolean;
	/** Timestamp of the most recent successful save (used by the titlebar indicator). */
	lastSavedAt: Date | null;

	loadProject: (projectId: string) => Promise<void>;
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
	) => Promise<boolean>;
	/** Merge a background enhancement into the latest document without adding an Undo step. */
	applyDocumentPatch: (
		projectId: string,
		patch: ProjectDocumentPatch,
		options?: {
			coalesceIntoHistory?: boolean;
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
const latestMutationByProject = new Map<string, number>();
const activeMutationCountByProject = new Map<string, number>();
const idleWaitersByProject = new Map<string, Array<() => void>>();

function persistDocument(document: AxcutDocument): Promise<AxcutDocument> {
	const operation = persistQueue.then(async () => {
		const result = await nativeBridgeClient.aiEdition.save(document);
		if (!result.success || !result.document) {
			throw new Error(result.error ?? "Failed to save project");
		}
		return parseDocument(result.document);
	});
	persistQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
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

export const useProjectStore = create<ProjectState>((set, get) => ({
	projectId: null,
	document: null,
	revision: 0,
	status: "idle",
	error: null,
	sourceDurationSec: 0,
	currentTimeSec: 0,
	playing: false,
	dirty: false,
	lastSavedAt: null,

	async loadProject(projectId) {
		const currentProjectId = get().projectId;
		const currentMutation = currentProjectId
			? beginTrackedProjectMutation(currentProjectId)
			: undefined;
		set({ status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.get(projectId);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to load project");
			}
			const document = parseDocument(result.document);
			set({
				projectId,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			clearDocumentHistory();
		} catch (error) {
			set({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			currentMutation?.finish();
		}
	},

	async createProject(title) {
		if (!requireEntitlement("edit")) throw new Error("Klippt Pro is required to create a project.");
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
					applyEditingDefaultPreferences(createdDocument, loadEditingPreferences()),
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
		if (!requireEntitlement("import")) return null;
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
		if (!requireEntitlement("edit")) return;
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
		if (!requireEntitlement("edit")) return false;
		const startingRevision = get().revision;
		const mutation = beginSave(document);
		try {
			const parsed = await persistDocument(document);
			if (
				get().projectId !== parsed.project.id ||
				get().revision !== startingRevision ||
				latestMutationByProject.get(parsed.project.id) !== mutation.operation
			) {
				return false;
			}
			set({
				document: parsed,
				revision: get().revision + 1,
				dirty: false,
				lastSavedAt: new Date(),
			});
			return true;
		} finally {
			mutation.finish();
		}
	},

	async saveDocumentIfCurrent(document, guard) {
		if (!requireEntitlement("edit")) return false;
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

	async saveDocumentAsEdit(document, historySnapshot) {
		if (!requireEntitlement("edit")) return false;
		const startingRevision = get().revision;
		const mutation = beginSave(document);
		const previous = historySnapshot ?? get().document;
		try {
			const parsed = await persistDocument(document);
			if (
				get().projectId !== parsed.project.id ||
				get().revision !== startingRevision ||
				latestMutationByProject.get(parsed.project.id) !== mutation.operation
			) {
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
				dirty: false,
				lastSavedAt: new Date(),
			});
			return true;
		} finally {
			mutation.finish();
		}
	},

	async applyDocumentPatch(projectId, patch, options) {
		if (!requireEntitlement("edit")) return "conflict";
		const maximumAttempts = Math.max(1, Math.floor(options?.maximumAttempts ?? 5));
		for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
			await waitForProjectMutations(projectId);
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
				? await state.saveDocumentAsEdit(next, historySnapshot)
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
		if (!requireEntitlement("edit")) return;
		const prev = get().document;
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
		if (!requireEntitlement("edit")) return;
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
	},

	restoreDocumentFromHistory(document) {
		if (!requireEntitlement("edit")) return;
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
	},

	async replaceTimeline(intervals, reason) {
		if (!requireEntitlement("edit")) return;
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = replaceTimelineOp(doc, intervals, reason);
		await get().saveDocument(next);
	},

	async restoreFullTimeline() {
		if (!requireEntitlement("edit")) return;
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
		clearDocumentHistory();
		set({
			projectId: null,
			document: null,
			revision: 0,
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
		set({ dirty: false, lastSavedAt: new Date() });
	},
}));

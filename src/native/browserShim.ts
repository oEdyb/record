// Browser-mode shim: when running in a plain browser (no Electron shell), provide
// stubs for window.electronAPI + nativeBridgeClient so the renderer renders.
// The dev server at http://localhost:5173 can be opened in Chrome/Firefox for
// rapid iteration without the Electron window overhead.

import { axcutSchemaVersion, migrateRawDocumentToCurrent } from "../lib/ai-edition/schema";
import type { EntitlementSnapshot } from "../lib/entitlements/contracts";
import { nativeBridgeClient as realClient } from "./client";

function detectBrowserMode(): boolean {
	if (typeof window === "undefined") return false;
	if (window.electronAPI) return false; // Electron present, no shim needed
	const params = new URLSearchParams(window.location.search);
	return params.has("browser") || params.get("windowType") === "editor";
}

function isBrowserMode(): boolean {
	return detectBrowserMode();
}

// ponytail: RecStage's source picker + recording-prefs need something to talk
// to in browser-mode preview too — real desktopCapturer isn't available in a
// plain browser tab, so fake a couple of plausible screen/window entries
// (no thumbnails; RecStage already falls back to an icon when thumbnail is
// null). Prefs persist to localStorage, same pattern as the LLM config shim
// below, so toggles survive a reload like the real main-process store would.
type ShimDesktopSource = {
	id: string;
	name: string;
	display_id: string;
	thumbnail: string | null;
	appIcon: string | null;
};
const SHIM_SOURCES: ShimDesktopSource[] = [
	{ id: "screen:0", name: "Entire Screen", display_id: "0", thumbnail: null, appIcon: null },
	{ id: "screen:1", name: "Display 2", display_id: "1", thumbnail: null, appIcon: null },
	{ id: "window:100", name: "Klippt", display_id: "", thumbnail: null, appIcon: null },
	{ id: "window:101", name: "Terminal", display_id: "", thumbnail: null, appIcon: null },
];
let shimSelectedSource: ShimDesktopSource | null = null;

type ShimRecordingPrefs = {
	micEnabled: boolean;
	micDeviceId: string | null;
	camEnabled: boolean;
	camDeviceId: string | null;
	camFormat: { width: number; height: number; fps: number };
	camFormatAuto: boolean;
	systemAudioEnabled: boolean;
	cursorCaptureMode: "editable-overlay" | "system";
};
const recordingPrefsStorageKey = "browser-shim-recording-prefs";
let shimRecordingPrefs: ShimRecordingPrefs = {
	micEnabled: false,
	micDeviceId: null,
	camEnabled: false,
	camDeviceId: null,
	camFormat: { width: 1920, height: 1080, fps: 30 },
	camFormatAuto: true,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
};
(() => {
	try {
		const raw = localStorage.getItem(recordingPrefsStorageKey);
		if (raw) shimRecordingPrefs = { ...shimRecordingPrefs, ...JSON.parse(raw) };
	} catch {
		// ponytail: corrupt/unavailable localStorage — start fresh.
	}
})();

// ponytail: real file dialogs/ffmpeg probing aren't available in a plain
// browser tab, but a hidden <input type="file"> + blob URL gets us a real,
// playable video without any native bridge — RecordingReviewShell/toFileUrl
// already special-case blob:/http(s):/data: asset paths and pass them
// through untouched, so this just has to produce one.
type PickVideoResult =
	| { success: true; canceled: false; path: string; name: string }
	| { success: false; canceled: true };

function pickVideoFileViaInput(): Promise<PickVideoResult> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept =
			"video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,video/x-ms-wmv,video/*";
		input.style.position = "fixed";
		input.style.top = "-9999px";
		let settled = false;
		const finish = (result: PickVideoResult) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(result);
		};
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				finish({ success: false, canceled: true });
				return;
			}
			finish({ success: true, canceled: false, path: URL.createObjectURL(file), name: file.name });
		});
		// Chrome fires this when the picker is dismissed without a selection.
		input.addEventListener("cancel", () => finish({ success: false, canceled: true }));
		document.body.appendChild(input);
		input.click();
	});
}

function createShimElectronAPI() {
	const entitlement: EntitlementSnapshot = {
		version: 1,
		provider: null,
		status: "development",
		access: "full",
		commerceConfigured: false,
		checkoutAvailable: false,
		managementAvailable: false,
	};
	return {
		assetBaseUrl: "",
		getEntitlement: () => Promise.resolve(entitlement),
		activateEntitlement: () => Promise.resolve(entitlement),
		refreshEntitlement: () => Promise.resolve(entitlement),
		deactivateEntitlement: () => Promise.resolve(entitlement),
		openEntitlementCheckout: () => Promise.resolve({ opened: false }),
		openEntitlementManagement: () => Promise.resolve({ opened: false }),
		onEntitlementChanged: () => () => undefined,
		writeClipboardText: (text: string) => navigator.clipboard.writeText(text),
		openVideoFilePicker: pickVideoFileViaInput,
		openProjectFile: () => Promise.resolve({ success: false, canceled: true }),
		pickExportSavePath: () => Promise.resolve({ success: false, canceled: true }),
		createTemporaryExportPath: () => Promise.resolve(""),
		removeTemporaryExportPath: () => Promise.resolve({ success: true }),
		writeExportToPath: () => Promise.resolve({ success: false }),
		cancelWriteExport: () => Promise.resolve({ cancelled: false }),
		getCurrentRecordingSession: () => Promise.resolve({ success: false, session: null }),
		switchToHud: () => Promise.resolve({ success: true }),
		switchToEditor: () => Promise.resolve({ success: true }),
		startNewRecording: () => Promise.resolve({ success: true }),
		getRecordingWorkspaceContext: () => Promise.resolve({ success: false, context: null }),
		setRecordingWorkspaceContext: () => Promise.resolve({ success: true, context: null }),
		returnToEditorIfRecordingWorkspace: () => Promise.resolve({ returned: false }),
		openSourceSelector: () => Promise.resolve({ success: true }),
		setHasUnsavedChanges: () => undefined,
		sendCloseConfirmResponse: () => undefined,
		onRequestCloseConfirm: () => () => undefined,
		onRequestSaveBeforeClose: () => () => undefined,
		loadProjectFileFromPath: () => Promise.resolve({ success: false, canceled: true }),
		getPathForFile: () => "",
		getSources: () => Promise.resolve(SHIM_SOURCES),
		selectSource: (source: ShimDesktopSource) => {
			shimSelectedSource = source;
			return Promise.resolve(source);
		},
		getSelectedSource: () => Promise.resolve(shimSelectedSource),
		onSelectedSourceChanged: () => () => undefined,
		getRecordingPrefs: () => Promise.resolve(shimRecordingPrefs),
		setRecordingPrefs: (patch: Partial<ShimRecordingPrefs>) => {
			shimRecordingPrefs = { ...shimRecordingPrefs, ...patch };
			try {
				localStorage.setItem(recordingPrefsStorageKey, JSON.stringify(shimRecordingPrefs));
			} catch {
				// ponytail: localStorage may be full or unavailable; silently skip
			}
			return Promise.resolve(shimRecordingPrefs);
		},
		onRecordingPrefsChanged: () => () => undefined,
		invokeNativeBridge: (req: { domain: string; action: string; payload?: unknown }) => {
			console.info("[browser-shim] invokeNativeBridge", req.domain, req.action, req.payload);
			return Promise.resolve({
				ok: true,
				data: null,
				meta: { version: 1, requestId: "shim", timestampMs: Date.now() },
			});
		},
	};
}

function createShimBridgeClient() {
	// ponytail: keyed by project id, matching the real DocumentService (one
	// file per project on disk). The previous shim kept a single global
	// `currentDoc` that `get(projectId)` ignored entirely — after a reload,
	// RecordingReviewShell's auto-load effect would call `listProjects()` (which
	// *did* remember every created project), pick the most recent one, then
	// `get()` that id and get back whatever `currentDoc` happened to be
	// (often null, if `save()` hadn't fired yet), throwing "Failed to load
	// project" on every reload. Same root cause broke addAsset/removeAsset:
	// they ignored `projectId` and read/returned the same possibly-null
	// `currentDoc`, which crashed downstream Zod parsing.
	type ShimDocument = {
		project: {
			id: string;
			title: string;
			createdAt: string;
			updatedAt: string;
			primaryAssetId?: string;
		};
		assets: Array<{ id: string; kind: "video"; label: string; originalPath: string }>;
		[key: string]: unknown;
	};
	const projectsStorageKey = "browser-shim-projects-v2";
	let documentsByProject: Record<string, ShimDocument> = {};
	let projectOrder: string[] = [];
	(() => {
		try {
			const raw = localStorage.getItem(projectsStorageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as {
				documents: Record<string, ShimDocument>;
				order: string[];
			};
			// ponytail: load-time migration. Older shims persisted v3 documents;
			// the renderer's `documentSchema.parse` now requires v5, so upgrade
			// any stale entries once on init (idempotent for v5 inputs).
			const loaded = parsed.documents ?? {};
			for (const [id, doc] of Object.entries(loaded)) {
				loaded[id] = migrateRawDocumentToCurrent(doc) as ShimDocument;
			}
			documentsByProject = loaded;
			projectOrder = parsed.order ?? [];
		} catch {
			// ponytail: corrupt/unavailable localStorage — start fresh rather
			// than crash the whole app on load.
		}
	})();
	const saveProjectsState = () => {
		try {
			localStorage.setItem(
				projectsStorageKey,
				JSON.stringify({ documents: documentsByProject, order: projectOrder }),
			);
		} catch {
			// ponytail: localStorage may be full or unavailable; silently skip
		}
	};
	const listProjectSummaries = () =>
		projectOrder
			.map((id) => documentsByProject[id])
			.filter((doc): doc is ShimDocument => Boolean(doc))
			.map((doc) => ({
				id: doc.project.id,
				title: doc.project.title,
				updatedAt: doc.project.updatedAt,
				assetCount: doc.assets.length,
			}));

	return {
		aiEdition: {
			listProjects: () => Promise.resolve(listProjectSummaries()),
			get: (projectId: string) => {
				const doc = documentsByProject[projectId];
				// ponytail: load-time migration. Older shims persisted v3 documents
				// in localStorage; the renderer's `documentSchema.parse` now requires
				// v5, so upgrade on read (idempotent for v5 inputs).
				const migrated = doc ? (migrateRawDocumentToCurrent(doc) as ShimDocument) : null;
				return Promise.resolve(
					migrated
						? { success: true, document: migrated }
						: { success: false, error: "Project not found" },
				);
			},
			create: (title?: string) => {
				const doc: ShimDocument = {
					// Mint at the current schema version so the renderer's
					// `documentSchema.parse` (a pure validator, no migration) accepts
					// the returned document. Must never be a literal: this value has to
					// track `axcutSchemaVersion` on every schema bump.
					schemaVersion: axcutSchemaVersion,
					project: {
						id: `proj_${Math.random().toString(36).slice(2, 10)}`,
						title: title || "Untitled Project",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
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
				documentsByProject[doc.project.id] = doc;
				projectOrder.unshift(doc.project.id);
				saveProjectsState();
				return Promise.resolve({ success: true, document: doc });
			},
			save: (doc: ShimDocument) => {
				const id = doc?.project?.id;
				if (!id) return Promise.resolve({ success: false, error: "Document has no project id" });
				documentsByProject[id] = doc;
				if (!projectOrder.includes(id)) projectOrder.unshift(id);
				saveProjectsState();
				return Promise.resolve({ success: true, document: doc });
			},
			delete: (projectId: string) => {
				delete documentsByProject[projectId];
				projectOrder = projectOrder.filter((id) => id !== projectId);
				saveProjectsState();
				return Promise.resolve({ success: true });
			},
			addAsset: (projectId: string, path: string, label?: string, recordingImportId?: string) => {
				const doc = documentsByProject[projectId];
				if (!doc) return Promise.resolve({ assetId: "", document: null });
				const assetId = `asset_${Math.random().toString(36).slice(2, 10)}`;
				const asset = {
					id: assetId,
					kind: "video" as const,
					label: label || path.split(/[\\/]/).pop() || "Recording",
					originalPath: path,
					...(recordingImportId ? { recordingImportId } : {}),
				};
				const next: ShimDocument = {
					...doc,
					assets: [...doc.assets, asset],
					project: { ...doc.project, primaryAssetId: doc.project.primaryAssetId ?? assetId },
				};
				documentsByProject[projectId] = next;
				saveProjectsState();
				return Promise.resolve({ assetId, document: next });
			},
			removeAsset: (projectId: string, assetId: string) => {
				const doc = documentsByProject[projectId];
				if (!doc) return Promise.resolve({ assetId, document: null });
				const next: ShimDocument = { ...doc, assets: doc.assets.filter((a) => a.id !== assetId) };
				documentsByProject[projectId] = next;
				saveProjectsState();
				return Promise.resolve({ assetId, document: next });
			},
		},
		project: {
			getCurrentContext: () =>
				Promise.resolve({ currentProjectPath: null, currentVideoPath: null }),
			loadProjectFile: () => Promise.resolve({ success: false, canceled: true }),
		},
	};
}

export function installBrowserShims(): void {
	if (typeof window === "undefined") return;
	if (!isBrowserMode()) return;
	if (!(window as unknown as { electronAPI?: unknown }).electronAPI) {
		(window as unknown as { electronAPI: unknown }).electronAPI = createShimElectronAPI();
	}
	// ponytail: replace the nativeBridgeClient on the window object. Components
	// import it from "@/native/client" at module load, so we patch the exported
	// object's methods to return shim responses. This keeps the import unchanged.
	const shim = createShimBridgeClient();
	const realKeys = Object.keys(realClient) as Array<keyof typeof realClient>;
	for (const domain of realKeys) {
		const realDomain = realClient[domain];
		const shimDomain = (shim as unknown as Record<string, unknown>)[domain as string];
		if (typeof realDomain === "object" && realDomain && shimDomain) {
			for (const action of Object.keys(realDomain) as Array<keyof typeof realDomain>) {
				const shimAction = (shimDomain as Record<string, unknown>)[action as string];
				if (typeof shimAction === "function") {
					(realDomain as Record<string, unknown>)[action as string] = shimAction;
				}
			}
		}
	}
	console.info("[openscreen] browser-mode shims active (no Electron)");
}

export { isBrowserMode };

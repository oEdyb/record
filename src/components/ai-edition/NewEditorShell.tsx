import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { useCleanVoiceRuntime } from "@/hooks/useCleanVoiceRuntime";
import { useReviewWindowCompact } from "@/hooks/useReviewWindowCompact";
import { applyTheme } from "@/hooks/useTheme";
import { registerAgentTransport } from "@/lib/ai-edition/agent/agentTransport";
import { migrateRawDocumentToCurrent } from "@/lib/ai-edition/document/migrate";
import { applyPauseSuggestions } from "@/lib/ai-edition/document/pause-edits";
import { recordingInterruptions } from "@/lib/ai-edition/document/recordingInterruptions";
import {
	applyProbedDuration,
	replaceTimeline as replaceTimelineOp,
	resolveClipInsertionBoundary,
	resolvePlaybackSegments,
} from "@/lib/ai-edition/document/timeline";
import { type AxcutClip, documentSchema } from "@/lib/ai-edition/schema";
import {
	exportRunPercent,
	isExportRunActive,
	useExportRunStore,
} from "@/lib/ai-edition/store/exportRunStore";
import { useProjectStore, waitForProjectMutations } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useAutoTranscription,
	useTimelineTranscriptGate,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { useUndoRedoShortcuts } from "@/lib/ai-edition/store/undo";
import { useSequentialTimelineOps } from "@/lib/ai-edition/store/useSequentialTimelineOps";
import { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { newRegionDurationSec } from "@/lib/ai-edition/timeline/newRegionDuration";
import {
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
	rawTimeToPlaybackTime,
	resolveNativePosition,
} from "@/lib/ai-edition/timeline/timelineMap";
import { transcriptRelevantAssetIds } from "@/lib/ai-edition/transcription/status";
import type { TranscriptLanguage } from "@/lib/captioning/transcriptLanguages";
import { requireEntitlement, useEntitlementStore } from "@/lib/entitlements/store";
import { formatExportEta } from "@/lib/exporter/mp4ExportSettings";
import { AUTOMATIC_TRANSCRIPTION_ENABLED, PRODUCT_SURFACE } from "@/lib/productSurface";
import type { RecordingWorkspaceContext } from "@/lib/recordingSession";
import { matchesShortcut } from "@/lib/shortcuts";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { nativeBridgeClient } from "@/native";
import type { AiEditionProjectSummary } from "@/native/contracts";
import { getCurrentNativeViewId } from "@/native/nativeCompositorStore";
import { getPreviewFrameEvidence, waitForPreviewSettledFrame } from "@/native/previewSettledFrames";
import { resolveVisibleClips } from "@/native/sceneDescription";
import { ExportDialog } from "./ExportDialog";
import { LeftPanel } from "./LeftPanel";
import { prepareLegacyProjectForOpen } from "./legacyProjectOpen";
import {
	EditClipModal,
	NewProjectModal,
	OpenProjectModal,
	type StartingPoint,
	UnsavedChangesModal,
	type UnsavedChoice,
} from "./Modals";
import { Preview } from "./Preview";
import { PreviewQualityControl } from "./PreviewQualityControl";
import { type SelectablePauseSuggestion, usePauseAnalysisStore } from "./pauses/pauseAnalysisStore";
import { RecordingReviewToolbar } from "./RecordingReviewToolbar";
import type { TrimTarget } from "./RightPanes";
import { importPendingRecording, isPendingRecordingImportInProgress } from "./recordingImport";
import { createRecordingReviewNavigation } from "./recordingReviewNavigation";
import {
	awaitRecordingReviewDocument,
	hasPendingRecordingHandoff,
} from "./recordingReviewReadiness";
import {
	canRegenerateAutomaticDirection,
	regenerateProjectAutomaticDirection,
} from "./regenerateAutomaticDirection";
import { TransactionRecoveryBanner } from "./TransactionRecoveryBanner";
import { TransportBar } from "./TransportBar";
import { useCompactReviewFit } from "./useCompactReviewFit";
import { useRecordingReviewMenu } from "./useRecordingReviewMenu";
import { useRecordingReviewShortcuts } from "./useRecordingReviewShortcuts";
import v4 from "./v4/EditorShellV4.module.css";
import { type EditorMode, EditorTopBar } from "./v4/EditorTopBar";
import { type Facet, FloatingInspector } from "./v4/FloatingInspector";
import { MediaStage } from "./v4/MediaStage";
import { V4Timeline } from "./v4/V4Timeline";

interface SeekTarget {
	timeSec: number;
	isSource?: boolean;
	requestId: number;
}

export function NewEditorShell() {
	useEffect(() => {
		let dispose: (() => void) | undefined;
		let active = true;
		void import("@/lib/ai-edition/agent/editorSession").then(({ installAgentEditorSession }) => {
			if (active) dispose = installAgentEditorSession();
		});
		return () => {
			active = false;
			dispose?.();
		};
	}, []);
	const te = useScopedT("editor");
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const projectRevision = useProjectStore((s) => s.revision);
	const dirty = useProjectStore((s) => s.dirty);
	const createProject = useProjectStore((s) => s.createProject);
	const addAsset = useProjectStore((s) => s.addAsset);
	const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
	const setSourceDuration = useProjectStore((s) => s.setSourceDuration);
	const loadProject = useProjectStore((s) => s.loadProject);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const pauseAnalysisProjectId = usePauseAnalysisStore((s) => s.projectId);
	const storedPauseSuggestions = usePauseAnalysisStore((s) => s.suggestions);
	const togglePauseSuggestion = usePauseAnalysisStore((s) => s.toggleSuggestion);
	const syncPauseAnalysisDocument = usePauseAnalysisStore((s) => s.syncDocument);
	const pauseSuggestions = pauseAnalysisProjectId === projectId ? storedPauseSuggestions : [];
	// Single source of truth for transport state (was local useState here AND, separately
	// and unused, in VirtualPreview — two copies independently wired to the same <video>
	// events could disagree, see the "stops at clip end" fix history). Anything that needs
	// to know or drive playback reads/writes this store field now, not a component-local copy.
	const playing = useProjectStore((s) => s.playing);
	const setPlaying = useProjectStore((s) => s.setPlaying);
	const entitlement = useEntitlementStore((s) => s.snapshot);
	const { routes: cleanVoiceRoutes } = useCleanVoiceRuntime(document);
	const openEntitlement = useEntitlementStore((s) => s.openDialog);
	const entitlementLabel = (() => {
		switch (entitlement.status) {
			case "trial-not-started":
				return te("entitlement.status.trialNotStarted");
			case "trial-active":
				return te(
					entitlement.trialDaysRemaining === 1
						? "entitlement.status.trialDay"
						: "entitlement.status.trialDays",
					{ count: entitlement.trialDaysRemaining ?? 0 },
				);
			case "offline-grace":
				return te("entitlement.status.offline");
			case "expired":
				return te("entitlement.status.readOnly");
			default:
				return null;
		}
	})();

	const [seekTarget, setSeekTarget] = useState<SeekTarget | null>(null);
	const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
	// Media and Edit are editor workspaces. Record is an action that opens the
	// floating HUD, not a third editor tab.
	// column, and a floating facet inspector over the stage.
	const [mode, setMode] = useState<EditorMode>("edit");
	const [chatOpen, setChatOpen] = useState<boolean>(
		() => PRODUCT_SURFACE.agentEditor && loadUserPreferences().editorChatOpen,
	);
	const [importingMedia, setImportingMedia] = useState(false);
	const [recordingReviewPending, setRecordingReviewPending] = useState(false);
	const [recordingReviewError, setRecordingReviewError] = useState<string | null>(null);
	const [recordingReviewActionPending, setRecordingReviewActionPending] = useState<
		"record" | "export" | null
	>(null);
	const recordingReviewActionRef = useRef(false);
	const [chatWidthPx, setChatWidthPx] = useState(
		() => Number(localStorage.getItem("os-editor-chat-width")) || 392,
	);
	const [timelineHeightPx, setTimelineHeightPx] = useState(
		() => Number(localStorage.getItem("os-editor-timeline-height")) || 308,
	);
	const [inspectorOpen, setInspectorOpen] = useState(true);
	const [facet, setFacet] = useState<Facet>("effects");
	const [openProjectOpen, setOpenProjectOpen] = useState(false);
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	// Crop + trim in/out both live in EditClipModal now (per-clip), reachable
	// from the timeline (double-click / pencil icon) and the inspector's
	// "Edit clip" rail button — a single shell-level instance instead of one
	// mounted per trigger site.
	const [editClipTarget, setEditClipTarget] = useState<AxcutClip | null>(null);
	const [exportOpen, setExportOpen] = useState(false);
	const [quickExport, setQuickExport] = useState(true);
	const [sourceExportBusy, setSourceExportBusy] = useState(false);
	const sourceExportBusyRef = useRef(false);
	const handleSourceExportBusyChange = useCallback((busy: boolean) => {
		// Menu and keyboard handlers must observe the lock before React renders.
		sourceExportBusyRef.current = busy;
		setSourceExportBusy(busy);
	}, []);
	// A background export keeps rendering after its dialog closes; the top bar shows it.
	const exportRunPhase = useExportRunStore((s) => s.phase);
	const exportRunProgress = useExportRunStore((s) => s.progress);
	const exportRun = useMemo(() => {
		// Only once the encoder is running: while the save sheet is open there is nothing to show.
		if (exportRunPhase !== "rendering" && exportRunPhase !== "writing") return null;
		const state = { phase: exportRunPhase, progress: exportRunProgress };
		const eta = exportRunProgress?.estimatedTimeRemaining ?? 0;
		return {
			percent: exportRunPercent(state),
			etaLabel:
				exportRunPhase === "rendering" && (exportRunProgress?.currentFrame ?? 0) > 1 && eta > 0
					? formatExportEta(eta)
					: null,
		};
	}, [exportRunPhase, exportRunProgress]);
	const [regeneratingAutomaticEdits, setRegeneratingAutomaticEdits] = useState(false);
	const [pausePreviewSuggestions, setPausePreviewSuggestions] = useState<
		SelectablePauseSuggestion[] | null
	>(null);
	const [unsavedPrompt, setUnsavedPrompt] = useState<{
		action: "close" | "new" | "open";
		resolve: (choice: UnsavedChoice) => void;
	} | null>(null);
	const toggleChat = useCallback(() => {
		if (!PRODUCT_SURFACE.agentEditor) return;
		setChatOpen((open) => {
			const next = !open;
			saveUserPreferences({ editorChatOpen: next });
			return next;
		});
	}, []);
	const handlePausePreview = useCallback(
		(suggestions: SelectablePauseSuggestion[] | null) => {
			setPausePreviewSuggestions(suggestions);
			const first = suggestions?.[0];
			if (!first) return;
			setCurrentTime(Math.max(0, first.timelineStartSec - 0.8));
			setPlaying(true);
		},
		[setCurrentTime, setPlaying],
	);
	useEffect(() => {
		syncPauseAnalysisDocument(projectId, projectRevision);
		setPausePreviewSuggestions(null);
	}, [projectId, projectRevision, syncPauseAnalysisDocument]);
	const { shortcuts, isMac, openConfig: openShortcutsConfig } = useShortcuts();
	// Transcription is local and every transcript-driven feature (Smart cuts,
	// captions, the transcript pane) needs one, so the editor produces them by
	// itself instead of waiting for the user to find the button. This hook is
	// the ONLY place the background pass is driven from — see transcriptionStore.
	useAutoTranscription(AUTOMATIC_TRANSCRIPTION_ENABLED);
	const requestTimelineTranscripts = useTranscriptionStore((s) => s.requestTimelineTranscripts);
	const requestTranscription = useTranscriptionStore((s) => s.request);
	// Resolved over the assets the TIMELINE plays, not over the primary asset: in
	// a recording project the primary asset is the screen capture, which is
	// routinely silent, and keying the transcript pane off it made the pane claim
	// "no audio track" for a project whose actual footage was mid-transcription.
	const transcriptGate = useTimelineTranscriptGate();
	// Per asset, for the transcript pane: only the block whose transcript is
	// actually being rewritten goes read-only. The gate answers "may a
	// transcript-dependent ACTION run?", which is a different question.
	const transcriptions = useAssetTranscriptions();
	const busyAssetIds = useMemo(
		() =>
			Object.values(transcriptions)
				.filter((v) => v.status === "running" || v.status === "queued")
				.map((v) => v.assetId),
		[transcriptions],
	);
	const tl = useTimeline();
	useUndoRedoShortcuts(() => {
		setPlaying(false);
		tl.clearSelection();
		const state = useProjectStore.getState();
		const timelineEnd = state.document?.timeline.clips.at(-1)?.timelineEndSec ?? 0;
		if (state.currentTimeSec > timelineEnd) state.setCurrentTime(timelineEnd);
	}, !PRODUCT_SURFACE.recordingOnly);
	const [copiedClipId, setCopiedClipId] = useState<string | null>(null);
	const [projectSummaries, setProjectSummaries] = useState<AiEditionProjectSummary[]>([]);
	const [projectListLoading, setProjectListLoading] = useState(false);
	const [projectListFailed, setProjectListFailed] = useState(false);
	const seekSeqRef = useRef(0);
	const initRef = useRef(false);
	const recordingResumeRef = useRef<Promise<boolean> | null>(null);
	const recordingHandoffPendingRef = useRef(false);
	const recordingNavigationRevisionRef = useRef(0);
	const recordingReviewNavigation = useMemo(
		() =>
			createRecordingReviewNavigation({
				isExporting: () =>
					PRODUCT_SURFACE.recordingOnly &&
					(sourceExportBusyRef.current || isExportRunActive(useExportRunStore.getState().phase)),
				isPreparing: () =>
					PRODUCT_SURFACE.recordingOnly &&
					Boolean(
						recordingResumeRef.current ||
							recordingHandoffPendingRef.current ||
							recordingReviewActionRef.current ||
							isPendingRecordingImportInProgress(),
					),
			}),
		[],
	);
	const handleOpenRecordings = useCallback(() => {
		recordingReviewNavigation.run(() => setOpenProjectOpen(true));
	}, [recordingReviewNavigation]);

	// Dev-only: expose the project store so the browser preview harness can
	// seed a populated document for design QA. Tree-shaken out of prod builds.
	if (import.meta.env.DEV) {
		(window as unknown as { __osProjectStore?: typeof useProjectStore }).__osProjectStore =
			useProjectStore;
	}

	// ponytail: serialise timeline-edit saves so two rapid Backspaces
	// don't race each other's save and overwrite one another in the
	// store. The hook reads the doc inside the chain (after awaiting the
	// previous save) — see its source for the race this fixes.
	const { apply: applyTimelineOp } = useSequentialTimelineOps({
		fallbackDocument: document,
		saveDocument,
	});

	const promptUnsaved = useCallback(
		(action: "close" | "new" | "open"): Promise<UnsavedChoice> => {
			if (!dirty) return Promise.resolve("discard");
			return new Promise<UnsavedChoice>((resolve) => {
				setUnsavedPrompt({ action, resolve });
			});
		},
		[dirty],
	);

	const primaryAssetPath =
		document?.assets.find((a) => a.id === document.project.primaryAssetId)?.originalPath ?? null;
	void primaryAssetPath;
	const clips: AxcutClip[] = document?.timeline.clips ?? [];
	const hasProject = Boolean(document);
	const hasAsset = projectId !== null && (document?.assets.length ?? 0) > 0;
	const project = document?.project
		? {
				id: document.project.id,
				title: document.project.title,
				updatedAt: new Date().toISOString(),
			}
		: null;

	// refresh project list when the Open Project modal is open
	useEffect(() => {
		if (!openProjectOpen) return;
		let current = true;
		setProjectListLoading(true);
		setProjectListFailed(false);
		void (async () => {
			try {
				const next = await nativeBridgeClient.aiEdition.listProjects();
				if (current) setProjectSummaries(next);
			} catch {
				if (current) setProjectListFailed(true);
			} finally {
				if (current) setProjectListLoading(false);
			}
		})();
		return () => {
			current = false;
		};
	}, [openProjectOpen]);

	const resumeRecordingWorkspace = useCallback(() => {
		if (recordingResumeRef.current) return recordingResumeRef.current;
		setRecordingReviewPending(true);
		setRecordingReviewError(null);

		const resume = (async () => {
			if (!window.electronAPI) return false;
			const workspaceResult = await window.electronAPI.getRecordingWorkspaceContext?.();
			const workspace = workspaceResult?.success ? workspaceResult.context : null;
			const restoreWorkspace = (context: RecordingWorkspaceContext, afterRecording: boolean) => {
				setMode(context.mode);
				setInspectorOpen(context.inspectorOpen);
				setFacet(context.facet);
				setCurrentTime(afterRecording ? context.insertionTimeSec : context.currentTimeSec);
			};
			try {
				if (await importPendingRecording()) {
					if (workspace) restoreWorkspace(workspace, true);
					if (recordingInterruptions(useProjectStore.getState().document).length === 0) {
						toast.success(workspace ? "Recording added" : "Recording added to a new project");
					}
					return true;
				}
			} catch (err) {
				setRecordingReviewError(err instanceof Error ? err.message : String(err));
				return true;
			}
			if (workspace) {
				try {
					await loadProject(workspace.projectId);
					const state = useProjectStore.getState();
					if (!state.document || state.document.project.id !== workspace.projectId) {
						throw new Error("Could not reopen the recording project");
					}
					restoreWorkspace(workspace, false);
					await window.electronAPI.setRecordingWorkspaceContext?.(null);
				} catch (err) {
					toast.error("Could not return to the project", {
						description: err instanceof Error ? err.message : String(err),
					});
				}
				return true;
			}
			return false;
		})().finally(async () => {
			recordingHandoffPendingRef.current = window.electronAPI
				? await hasPendingRecordingHandoff(() => window.electronAPI.getCurrentRecordingSession())
				: false;
		});

		recordingResumeRef.current = resume;
		const clearResume = () => {
			if (recordingResumeRef.current === resume) {
				recordingResumeRef.current = null;
				setRecordingReviewPending(recordingHandoffPendingRef.current);
			}
		};
		void resume.then(clearResume, clearResume);
		return resume;
	}, [loadProject, setCurrentTime]);

	// A cold editor consumes a pending recording on mount. A warm editor is hidden
	// while the HUD records, then consumes the hand-off when Electron shows it again.
	useEffect(() => {
		const resumeWorkspace = () => {
			void resumeRecordingWorkspace().catch((error) =>
				console.warn("[editor] could not resume recording workspace:", error),
			);
		};
		const unsubscribe = window.electronAPI?.onRecordingWorkspaceReturned?.(resumeWorkspace);
		const handleVisibilityChange = () => {
			if (globalThis.document.visibilityState === "visible") {
				resumeWorkspace();
			}
		};
		globalThis.document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			unsubscribe?.();
			globalThis.document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [resumeRecordingWorkspace]);

	// Auto-load project recording session on mount.
	useEffect(() => {
		if (initRef.current) return;
		initRef.current = true;
		void (async () => {
			if (await resumeRecordingWorkspace()) return;
			const navigationRevision = recordingNavigationRevisionRef.current;
			const projectAtStart = useProjectStore.getState().projectId;
			const canApply = () =>
				!recordingReviewNavigation.isBlocked() &&
				recordingNavigationRevisionRef.current === navigationRevision &&
				useProjectStore.getState().projectId === projectAtStart;
			// ponytail: no recording waiting — restore the user's most recent
			// project. The browser-shim's listProjects returns the seeded
			// `browser-shim-projects` entries, so e2e tests can land directly in a
			// populated editor; for real Electron users this is the expected "open
			// last project on launch" UX — and, now that the recording hand-off is
			// consumed on import, it is also what reopening the editor after a
			// recording lands on: the project that recording went into, settings and
			// all, instead of a second project on the same file.
			try {
				const projects = await nativeBridgeClient.aiEdition.listProjects();
				console.info("[editor] listProjects returned", projects);
				if (projects.length > 0) {
					console.info("[editor] auto-loading project", projects[0].id);
					await loadProject(projects[0].id, { canApply });
					const state = useProjectStore.getState();
					console.info(
						"[editor] post-loadProject status=",
						state.status,
						"error=",
						JSON.stringify(state.error),
						"doc=",
						state.document ? "loaded" : "null",
					);
				}
			} catch (e) {
				console.warn("[editor] auto-load failed", e);
			}
		})();
	}, [loadProject, recordingReviewNavigation, resumeRecordingWorkspace]);

	// Warn on close when dirty
	useEffect(() => {
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			if (useProjectStore.getState().dirty) {
				e.preventDefault();
				e.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);

	// Electron close interception
	useEffect(() => {
		if (!window.electronAPI) return;

		// 1. Sync dirty state to Electron main process
		window.electronAPI.setHasUnsavedChanges(dirty);
	}, [dirty]);

	useEffect(() => {
		if (!window.electronAPI) return;

		// 2. Handle request-close-confirm from Electron
		const unsubCloseConfirm = window.electronAPI.onRequestCloseConfirm(() => {
			void (async () => {
				const choice = await promptUnsaved("close");
				if (choice === "discard") {
					window.electronAPI.sendCloseConfirmResponse("discard");
				} else if (choice === "save") {
					window.electronAPI.sendCloseConfirmResponse("save");
				} else {
					window.electronAPI.sendCloseConfirmResponse("cancel");
				}
			})();
		});

		// 3. Handle request-save-before-close from Electron
		const unsubSaveBeforeClose = window.electronAPI.onRequestSaveBeforeClose(async () => {
			const doc = useProjectStore.getState().document;
			if (doc) {
				try {
					await saveDocument(doc);
					return true;
				} catch {
					toast.error("Failed to save before closing");
					return false;
				}
			}
			return true;
		});

		return () => {
			unsubCloseConfirm?.();
			unsubSaveBeforeClose?.();
		};
	}, [promptUnsaved, saveDocument]);

	const videoSources = useMemo(() => {
		if (!document) return [];
		return document.assets.map((asset) => {
			const cleanVoice = cleanVoiceRoutes.get(asset.id);
			return {
				id: asset.id,
				// Real Electron assets are filesystem paths and go through toFileUrl.
				// In the browser preview an asset can already point at an http(s)/
				// blob/data URL served by Vite; toFileUrl would mangle those into a
				// broken file:// URL, so pass web URLs through untouched.
				src: /^(https?|blob|data):/.test(asset.originalPath)
					? asset.originalPath
					: toFileUrl(asset.originalPath),
				label: asset.label,
				...(cleanVoice ? { audioSrc: toFileUrl(cleanVoice.previewAudioPath) } : {}),
			};
		});
	}, [cleanVoiceRoutes, document]);

	const handleLoadedMetadata = useCallback(
		(durationSec: number, assetId: string) => {
			if (isPendingRecordingImportInProgress()) return;
			// ponytail: WebM recordings from MediaRecorder report NaN/Infinity
			// until the main-process EBML fix lands. Fall back to a 60s seed if
			// duration is unknown so the timeline never gets stuck on an empty
			// placeholder. All store reads go through getState() to avoid
			// stale-closure bugs.
			const known = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 60;
			const state = useProjectStore.getState();
			setSourceDuration(known);
			const doc = state.document;
			if (!doc || doc.assets.length === 0) return;
			if (doc.timeline.clips.length === 0) {
				// ponytail: replaceTimeline derives clip length from
				// asset.durationSec, which import never populates — without this
				// patch the first auto-created clip silently comes out empty
				// (normalizeIntervals clamps against a 0 duration and drops it).
				const primaryAssetId = doc.project.primaryAssetId ?? doc.assets[0]?.id;
				const docWithDuration = primaryAssetId
					? {
							...doc,
							assets: doc.assets.map((a) =>
								a.id === primaryAssetId ? { ...a, durationSec: known } : a,
							),
						}
					: doc;
				const next = replaceTimelineOp(
					docWithDuration,
					[{ startSec: 0, endSec: known }],
					"Auto-created full-duration clip",
				);
				void state.saveDocument(next);
				return;
			}
			// Hand the probed duration to the pure document layer: it patches only the
			// clips of THIS asset that are still waiting for a real length (the
			// pre-probe placeholder, or the extent-less clip a legacy v2 import mints),
			// shifts what follows, and brings the modifiers along — anchoring the ones
			// migration had to leave unanchored. Returns the document untouched when
			// nothing is waiting, so there is nothing to guard here.
			const next = applyProbedDuration(doc, assetId, known);
			if (next !== doc) {
				void state.saveDocument(next);
			}
		},
		[setSourceDuration],
	);

	const handleSeek = useCallback(
		(timeSec: number) => {
			setCurrentTime(timeSec);
			setSeekTarget({ timeSec, isSource: false, requestId: ++seekSeqRef.current });
		},
		[setCurrentTime],
	);

	// The agent bridge drives playback through the same paths the transport bar and
	// the timeline use, so a scripted run reproduces what a user does.
	useEffect(() => {
		return registerAgentTransport({
			seek: handleSeek,
			click: (testId, fraction) => {
				const target = window.document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
				const canvas =
					window.document.querySelector<HTMLElement>('[data-testid="timeline-canvas"]') ?? target;
				if (!target || !canvas) throw new Error(`CLICK_TARGET_MISSING: ${testId}`);
				const canvasRect = canvas.getBoundingClientRect();
				const targetRect = target.getBoundingClientRect();
				const init: PointerEventInit = {
					bubbles: true,
					cancelable: true,
					clientX: canvasRect.left + fraction * canvasRect.width,
					clientY: targetRect.top + targetRect.height / 2,
					button: 0,
					buttons: 1,
					pointerId: 1,
					pointerType: "mouse",
					isPrimary: true,
				};
				target.dispatchEvent(new PointerEvent("pointerdown", init));
				window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
			},
			wheel: (testId, fraction, deltaX, deltaY, ctrl) => {
				const target = window.document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
				if (!target) throw new Error(`WHEEL_TARGET_MISSING: ${testId}`);
				const rect = target.getBoundingClientRect();
				target.dispatchEvent(
					new WheelEvent("wheel", {
						bubbles: true,
						cancelable: true,
						clientX: rect.left + fraction * rect.width,
						clientY: rect.top + rect.height / 2,
						deltaX,
						deltaY,
						ctrlKey: ctrl,
					}),
				);
			},
			frame: () => {
				const source = window.document.querySelector<HTMLCanvasElement>(
					'[data-testid="native-compositor-mount"]',
				);
				if (!source || source.width === 0) return null;
				const small = window.document.createElement("canvas");
				small.width = 192;
				small.height = Math.max(1, Math.round((192 * source.height) / source.width));
				small.getContext("2d")?.drawImage(source, 0, 0, small.width, small.height);
				return small.toDataURL("image/jpeg", 0.5);
			},
			frameEvidence: getPreviewFrameEvidence,
			awaitFrameSettled: (budgetMs) => {
				const state = useProjectStore.getState();
				const viewId = getCurrentNativeViewId();
				if (!state.document || viewId === null) return Promise.resolve(false);
				const position = resolveNativePosition(
					state.currentTimeSec,
					resolveVisibleClips(state.document),
					state.document.timeline.clips,
				);
				return position
					? waitForPreviewSettledFrame(budgetMs, {
							viewId,
							sceneIdentity: state.document,
							playing: state.playing,
							clipIndex: position.clipIndex,
							sourceTimeSec: position.sourceTimeSec,
						})
					: Promise.resolve(false);
			},
			play: () => {
				void videoElement?.play().catch(() => {
					// swallow: rejection just means playback never started
				});
			},
			pause: () => videoElement?.pause(),
			snapshot: () => {
				const state = useProjectStore.getState();
				return {
					currentTimeSec: state.currentTimeSec,
					playing: state.playing,
					videoTimeSec: videoElement?.currentTime ?? null,
					videoPaused: videoElement?.paused ?? null,
					videoConnected: videoElement?.isConnected ?? null,
					videos: Array.from(window.document.querySelectorAll("video")).map((video) => ({
						src: video.currentSrc.split("/").pop() ?? "",
						currentTimeSec: Number(video.currentTime.toFixed(3)),
						paused: video.paused,
						readyState: video.readyState,
					})),
				};
			},
		});
	}, [handleSeek, videoElement]);

	const handleTimeChange = useCallback(
		(timeSec: number) => {
			setCurrentTime(timeSec);
		},
		[setCurrentTime],
	);

	const handleDropAsset = useCallback(
		(assetId: string) => {
			void tl.insertClipAt(assetId, clips.length);
		},
		[tl, clips.length],
	);

	// Ref so the 'ended' listener below always sees the latest clips without tearing
	// down and re-registering the DOM listener on every document change. (The playhead
	// it also needs is read straight off the store at call time, so the full shell
	// does not subscribe to per-frame transport updates.)
	const clipsForEndedRef = useRef(clips);
	clipsForEndedRef.current = clips;

	// ponytail: the transport bar (play/pause, prev/next, loop, fullscreen)
	// lives in the timeline header now, not under the preview canvas — it
	// needs the video element, so this state/these handlers moved up here
	// from Preview.tsx to be shared with Bottombar.
	useEffect(() => {
		const el = videoElement;
		if (!el) return;
		const onPlay = () => setPlaying(true);
		const onPause = () => setPlaying(false);
		// BUG corrigé : ce listener écoutait le même événement DOM natif 'ended' que le
		// onEnded interne de VirtualPreview.tsx, sans la moindre logique multi-clip — il
		// mettait TOUJOURS `playing` à false, y compris quand VirtualPreview venait
		// juste d'enchaîner sur le clip suivant (les deux listeners réagissent au même
		// événement, indépendamment). Deux endroits qui décident chacun de leur côté si
		// la lecture doit s'arrêter = exactement le genre de duplication qui casse selon
		// le chemin UX emprunté. On applique ici le même critère "y a-t-il un clip
		// suivant ?" déjà utilisé par handleNextClip juste au-dessus — seul point de
		// vérité pour "y a-t-il encore de la timeline à jouer".
		const onEnded = () => {
			const playhead = useProjectStore.getState().currentTimeSec;
			const hasNextClip = clipsForEndedRef.current.some((c) => c.timelineStartSec > playhead + 0.1);
			if (!hasNextClip) setPlaying(false);
		};
		el.addEventListener("play", onPlay);
		el.addEventListener("pause", onPause);
		el.addEventListener("ended", onEnded);
		setPlaying(!el.paused);
		return () => {
			el.removeEventListener("play", onPlay);
			el.removeEventListener("pause", onPause);
			el.removeEventListener("ended", onEnded);
		};
		// setPlaying is a stable Zustand action reference (never recreated), so listing it
		// here doesn't cause this effect to re-subscribe on every playhead tick.
	}, [videoElement, setPlaying]);

	const togglePlay = useCallback(() => {
		if (!videoElement) return;
		if (videoElement.paused) {
			// Same catch as VirtualPreview's: `play()` rejects on the autoplay policy
			// or when a new load interrupts it, and the store's `playing` flag is
			// driven by the element's own play/pause listeners above — so a rejection
			// leaves nothing to reconcile, it just must not escape unhandled.
			void videoElement.play().catch(() => {
				// swallow: rejection just means playback never started
			});
		} else {
			videoElement.pause();
		}
	}, [videoElement]);

	const handlePrevClip = useCallback(() => {
		if (clips.length === 0) return;
		// ponytail: navigate in virtual timeline space, not source-media time.
		const playhead = useProjectStore.getState().currentTimeSec;
		let prevStart = 0;
		for (let i = clips.length - 1; i >= 0; i--) {
			const c = clips[i];
			if (c.timelineEndSec <= playhead - 0.1) {
				prevStart = c.timelineStartSec;
				break;
			}
		}
		handleSeek(prevStart);
		handleTimeChange(prevStart);
	}, [clips, handleSeek, handleTimeChange]);

	const handleNextClip = useCallback(() => {
		if (clips.length === 0) return;
		const playhead = useProjectStore.getState().currentTimeSec;
		const next = clips.find((c) => c.timelineStartSec > playhead + 0.1);
		if (!next) return;
		handleSeek(next.timelineStartSec);
		handleTimeChange(next.timelineStartSec);
	}, [clips, handleSeek, handleTimeChange]);

	// "Transcribe now" from the transcript pane. The run itself belongs to the
	// transcription store (it owns the queue, the toasts and the failure
	// bookkeeping) — all the shell adds is bringing the transcript into view
	// once it lands.
	const handleTranscribe = useCallback(
		async (language?: TranscriptLanguage) => {
			const before = useProjectStore.getState().document?.transcripts.length ?? 0;
			if (language) {
				const currentDocument = useProjectStore.getState().document;
				await Promise.all(
					transcriptRelevantAssetIds(currentDocument).map((assetId) =>
						requestTranscription(assetId, language),
					),
				);
			} else {
				await requestTimelineTranscripts();
			}
			if ((useProjectStore.getState().document?.transcripts.length ?? 0) > before) {
				setMode("edit");
				setFacet("transcript");
				setInspectorOpen(true);
			}
		},
		[requestTimelineTranscripts, requestTranscription],
	);

	const handleBrowseProject = useCallback(async () => {
		const projectAtStart = useProjectStore.getState().projectId;
		const navigationRevision = recordingNavigationRevisionRef.current;
		const isCurrent = () =>
			useProjectStore.getState().projectId === projectAtStart &&
			recordingNavigationRevisionRef.current === navigationRevision;
		const canApply = () => !recordingReviewNavigation.isBlocked() && isCurrent();
		try {
			await recordingReviewNavigation.runAfter(
				async () => window.electronAPI?.loadProjectFile(),
				async (result) => {
					if (!result?.success || !result.project) return;
					const raw = result.project as unknown;
					// Current documents carry their version; older exports need migration.
					const isAxcutDocument =
						typeof raw === "object" && raw !== null && "schemaVersion" in raw && "timeline" in raw;
					const doc = isAxcutDocument
						? documentSchema.parse(migrateRawDocumentToCurrent(raw))
						: await prepareLegacyProjectForOpen(raw as EditorProjectData);
					if (!canApply()) return;
					const saved = await nativeBridgeClient.aiEdition.importProject(doc);
					if (!canApply()) return;
					if (saved.success && saved.document) {
						const targetProjectId = documentSchema.parse(saved.document).project.id;
						await loadProject(targetProjectId, { canApply });
						if (
							recordingReviewNavigation.isBlocked() ||
							recordingNavigationRevisionRef.current !== navigationRevision ||
							useProjectStore.getState().projectId !== targetProjectId
						)
							return;
						toast.success(
							isAxcutDocument ? "Project copy opened" : "Legacy project copied and loaded",
						);
					} else {
						toast.error(saved.error ?? "Failed to open project");
					}
				},
				isCurrent,
			);
		} catch (err) {
			toast.error("Could not load project", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [loadProject, recordingReviewNavigation]);

	// ponytail: transcript-pane → timeline skip ranges. The right pane's
	// contentEditable region converts user Backspace/Delete into a new
	// trimRange (NOT a destructive word removal — the source text stays
	// intact, the word is just hidden by the skip overlay). Mirrors
	// axcut's `queueAddTrimRange` / `queueRemoveTrimRange` callbacks in
	// apps/web/src/App.tsx. The serialised save + inside-the-chain doc
	// read is owned by `useSequentialTimelineOps` above.
	const handleAddTrimRange = useCallback(
		(target: TrimTarget, startSec: number, endSec: number, reason: string) => {
			// `clipId` is what keeps the cut on the block the user typed in: with two clips
			// over the same media, an asset-only trim showed up on both (see `trimAppliesToClip`).
			void applyTimelineOp({
				type: "add_trim_range",
				assetId: target.assetId,
				clipId: target.clipId,
				startSec,
				endSec,
				reason,
			});
		},
		[applyTimelineOp],
	);

	const handleRemoveTrimRange = useCallback(
		(trimId: string) => {
			void applyTimelineOp({
				type: "remove_trim_range",
				trimId,
				reason: "Restored from transcript pane.",
			});
		},
		[applyTimelineOp],
	);

	const handleSelectProject = useCallback(
		async (id: string) => {
			if (recordingReviewNavigation.isBlocked()) return;
			const projectAtStart = useProjectStore.getState().projectId;
			const navigationRevision = recordingNavigationRevisionRef.current;
			try {
				await loadProject(id, {
					canApply: () =>
						!recordingReviewNavigation.isBlocked() &&
						recordingNavigationRevisionRef.current === navigationRevision &&
						useProjectStore.getState().projectId === projectAtStart,
				});
			} catch (err) {
				toast.error("Could not open project", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[loadProject, recordingReviewNavigation],
	);

	// The dialog's starting point either opens Media or moves directly to the
	// idle floating recording panel for the new project.
	const handleCreateProject = useCallback(
		async (title: string, startingPoint: StartingPoint) => {
			try {
				const created = await createProject(title);
				if (startingPoint === "screen-recording") {
					await window.electronAPI?.startNewRecording?.({
						origin: "editor",
						projectId: created.project.id,
						insertionTimeSec: 0,
						currentTimeSec: 0,
						mode: "edit",
						inspectorOpen: true,
						facet: "effects",
					});
				} else {
					setMode(PRODUCT_SURFACE.mediaWorkspace ? "media" : "edit");
				}
			} catch (err) {
				toast.error("Could not create project", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[createProject],
	);

	// The only way to get rid of a project short of deleting its file by hand.
	// Media is left alone on purpose: a recording can back several projects, and
	// the dialog says so before it asks.
	const handleDeleteProject = useCallback(
		async (id: string) => {
			if (recordingReviewNavigation.isBlocked()) return;
			try {
				const result = await nativeBridgeClient.aiEdition.delete(id);
				if (!result.success) throw new Error(result.error ?? "Failed to delete project");
				setProjectSummaries((prev) => prev.filter((p) => p.id !== id));
				// Deleting the project that is open leaves the editor pointing at a file
				// that no longer exists — any save from there would recreate it.
				if (useProjectStore.getState().projectId === id) {
					useProjectStore.getState().clear();
				}
				toast.success("Project deleted");
			} catch (err) {
				toast.error("Could not delete project", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[recordingReviewNavigation],
	);

	const handleSave = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		try {
			await saveDocument(doc);
			toast.success("Project saved");
		} catch (err) {
			toast.error("Save failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [saveDocument]);

	// Native File menu (electron/main.ts) → v4 actions. The menu is shown via
	// Menu.setApplicationMenu and dispatches these IPC events; the old editor
	// listened to them, but the v4 shell replaced it, leaving the File items
	// dead. Wire them to the same handlers the top-bar buttons use so the
	// File/Edit/View menu bar works again (Edit/View items use Electron roles).
	// The v4 editor has no separate "Save As" location, so it maps to Save.
	useEffect(() => {
		if (PRODUCT_SURFACE.recordingOnly) return;
		const api = window.electronAPI;
		if (!api) return;
		const unsubscribers = [
			api.onMenuNewProject?.(() => setNewProjectOpen(true)),
			api.onMenuLoadProject?.(() => setOpenProjectOpen(true)),
			api.onMenuSaveProject?.(() => void handleSave()),
			api.onMenuSaveProjectAs?.(() => void handleSave()),
		];
		return () => {
			for (const unsub of unsubscribers) unsub?.();
		};
	}, [handleSave]);

	const handleRenameProject = useCallback(
		async (title: string) => {
			if (!requireEntitlement("edit")) return;
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			if (title === doc.project.title) return;
			try {
				await saveDocument({ ...doc, project: { ...doc.project, title } });
			} catch (err) {
				toast.error("Rename failed", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[saveDocument],
	);

	const handleConfirmUnsaved = useCallback(
		(choice: UnsavedChoice) => {
			if (!unsavedPrompt) return;
			const { resolve } = unsavedPrompt;
			setUnsavedPrompt(null);
			// ponytail: resolve the action when the user picks save / discard.
			// The caller continues its open/new/close action after this promise resolves.
			void (async () => {
				if (choice === "cancel") {
					resolve("cancel");
					return;
				}
				if (choice === "save") {
					const doc = useProjectStore.getState().document;
					if (doc) {
						try {
							await saveDocument(doc);
						} catch {
							resolve("cancel");
							return;
						}
					}
				}
				resolve(choice);
			})();
		},
		[saveDocument, unsavedPrompt],
	);

	const handleImportMedia = useCallback(async () => {
		if (!requireEntitlement("import")) return;
		if (!useProjectStore.getState().projectId || importingMedia) return;
		const picker = await window.electronAPI?.openVideoFilePicker?.();
		if (!picker?.success) {
			if (picker?.code === "ENTITLEMENT_REQUIRED") openEntitlement("import");
			return;
		}
		if (picker.canceled || !picker.path) return;

		setImportingMedia(true);
		try {
			const label = picker.name || picker.path.split(/[\\/]/).pop() || "Video";
			const asset = await addAsset(picker.path, label);
			if (!asset) throw new Error("The imported file was not added to the project");
			const insertAt = useProjectStore.getState().document?.timeline.clips.length ?? 0;
			await tl.insertClipAt(asset.id, insertAt);
			toast.success(te("mediaStage.added", { label }));
		} catch (error) {
			toast.error(te("mediaStage.couldNotAddAsset"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setImportingMedia(false);
		}
	}, [addAsset, importingMedia, openEntitlement, te, tl]);

	const handleNewRecording = useCallback(async () => {
		if (
			recordingReviewActionRef.current ||
			sourceExportBusyRef.current ||
			isExportRunActive(useExportRunStore.getState().phase)
		)
			return;
		if (!requireEntitlement("record")) return;
		const api = window.electronAPI;
		if (!api?.startNewRecording) return;
		recordingReviewActionRef.current = true;
		setRecordingReviewActionPending("record");
		setPlaying(false);
		recordingNavigationRevisionRef.current += 1;
		setOpenProjectOpen(false);
		try {
			await resumeRecordingWorkspace();
			const pending = await api.getCurrentRecordingSession();
			if (pending.success && pending.session) {
				throw new Error("The current recording is still being prepared. Try again shortly.");
			}
			// Stop the playback clock synchronously before any awaited save. Reading
			// the store after this gives one authoritative playhead for both return
			// state and insertion placement.
			setPlaying(false);
			const activeProjectId = useProjectStore.getState().projectId;
			if (activeProjectId) await waitForProjectMutations(activeProjectId);
			let state = useProjectStore.getState();
			let currentDocument = state.document;
			// The editor window closes during the workspace switch. Save first so
			// reopening the project is exact and never needs an unsaved-changes modal.
			if (currentDocument && state.dirty) await saveDocument(currentDocument);
			state = useProjectStore.getState();
			currentDocument = state.document;
			const context: RecordingWorkspaceContext | undefined =
				state.projectId && currentDocument && !PRODUCT_SURFACE.recordingOnly
					? {
							origin: "editor",
							projectId: state.projectId,
							insertionTimeSec: resolveClipInsertionBoundary(
								currentDocument.timeline.clips,
								state.currentTimeSec,
							),
							currentTimeSec: state.currentTimeSec,
							mode,
							inspectorOpen,
							facet,
						}
					: undefined;
			// A source picker/copy can start while the workspace or dirty save awaits.
			if (
				sourceExportBusyRef.current ||
				isExportRunActive(useExportRunStore.getState().phase) ||
				recordingHandoffPendingRef.current ||
				isPendingRecordingImportInProgress()
			)
				return;
			const result = await api.startNewRecording(context);
			if (!result.success) {
				if (result.code === "ENTITLEMENT_REQUIRED") {
					openEntitlement("record");
					return;
				}
				throw new Error(result.error ?? "Could not open recording controls");
			}
		} catch (err) {
			toast.error("Could not open recording controls", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			recordingReviewActionRef.current = false;
			setRecordingReviewActionPending(null);
		}
	}, [
		facet,
		inspectorOpen,
		mode,
		openEntitlement,
		resumeRecordingWorkspace,
		saveDocument,
		setPlaying,
	]);

	const openRecordingExport = useCallback(
		async (sourceRecovery: boolean) => {
			if (sourceExportBusyRef.current || recordingReviewActionRef.current) return;
			if (!sourceRecovery && !requireEntitlement("export")) return;
			recordingReviewActionRef.current = true;
			setRecordingReviewActionPending("export");
			try {
				const ready = await awaitRecordingReviewDocument({
					refreshWorkspace: resumeRecordingWorkspace,
					getCurrentRecordingSession: () => window.electronAPI.getCurrentRecordingSession(),
					getProjectState: useProjectStore.getState,
				});
				if (!ready) {
					toast.info(
						te(
							useProjectStore.getState().document?.timeline.clips.length
								? "recordingReview.preparing"
								: "recordingReview.recordFirst",
						),
					);
					return;
				}
				setQuickExport(!sourceRecovery);
				setExportOpen(true);
			} catch (error) {
				toast.error(te("recordingReview.preparing"), {
					description: error instanceof Error ? error.message : String(error),
				});
			} finally {
				recordingReviewActionRef.current = false;
				setRecordingReviewActionPending(null);
			}
		},
		[resumeRecordingWorkspace, te],
	);
	const handleExport = useCallback(() => {
		if (PRODUCT_SURFACE.recordingOnly) {
			void openRecordingExport(false);
			return;
		}
		if (!hasAsset || !requireEntitlement("export")) return;
		setQuickExport(false);
		setExportOpen(true);
	}, [hasAsset, openRecordingExport]);

	const handleRegenerateAutomaticEdits = useCallback(async () => {
		if (!requireEntitlement("automatic-editing")) return;
		const activeProjectId = useProjectStore.getState().projectId;
		if (!activeProjectId || regeneratingAutomaticEdits) return;
		setPlaying(false);
		setRegeneratingAutomaticEdits(true);
		try {
			const result = await regenerateProjectAutomaticDirection(activeProjectId);
			const total = result.screenZooms + result.cameraEmphasis;
			if (total === 0) {
				toast.info("No automatic edits matched the current rules");
			} else {
				toast.success("Automatic edits applied", {
					description: `${result.screenZooms} Zoom${result.screenZooms === 1 ? "" : "s"} and ${result.cameraEmphasis} Camera Emphasis region${result.cameraEmphasis === 1 ? "" : "s"}.`,
				});
			}
		} catch (error) {
			toast.error("Could not apply automatic edits", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setRegeneratingAutomaticEdits(false);
		}
	}, [regeneratingAutomaticEdits, setPlaying]);

	const handleOpenSettings = useCallback(() => {
		openShortcutsConfig();
	}, [openShortcutsConfig]);

	const pasteRegion = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const { pasteClipboard } = await import("@/lib/ai-edition/store/regionClipboard");
		const snapshot = pasteClipboard();
		if (!snapshot) return;

		// A copied trim is just a length: recreate one of that length at the
		// playhead, through the same call the toolbar's cut button uses (which
		// resolves the timeline span down to the carrying clip's source time).
		if (snapshot.kind === "trim") {
			await tl.addTrim(snapshot.region.durationSec);
			toast.success("Region pasted");
			return;
		}

		const { anchorRegionsWithDerivedMs } = await import("@/lib/ai-edition/timeline/timelineMap");
		const { createId } = await import("@/lib/ai-edition/document/ids");

		// Land it at the playhead, keeping the copied length.
		const timeMs = Math.round(useProjectStore.getState().currentTimeSec * 1000);
		const src = snapshot.region as { startMs: number; endMs: number };
		const prefix = snapshot.kind === "annotation" ? "ann" : snapshot.kind;
		const pasted = {
			...snapshot.region,
			id: createId(prefix),
			startMs: timeMs,
			endMs: timeMs + (Number(src.endMs) - Number(src.startMs)),
		};
		// Anchor to the clip(s) it covers, exactly like every add* does. Pasting
		// used to store a bare startMs/endMs, so the region survived until the
		// first clip reorder or trim and then drifted off its content — see
		// technical-documentation/architecture/timeline-model.md.
		const anchored = anchorRegionsWithDerivedMs(
			[pasted as unknown as { id: string; startMs: number; endMs: number }],
			doc.timeline.clips,
			() => createId(prefix),
		);

		if (snapshot.kind === "zoom") {
			await saveDocument({
				...doc,
				zoomRanges: [...doc.zoomRanges, ...anchored] as typeof doc.zoomRanges,
			});
		} else if (snapshot.kind === "annotation") {
			await saveDocument({
				...doc,
				annotations: [...doc.annotations, ...anchored] as typeof doc.annotations,
			});
		} else {
			// speed and cameraFullscreen are both plain spans on legacyEditor.
			const key = snapshot.kind === "speed" ? "speedRegions" : "cameraFullscreenRegions";
			const legacy = (doc.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy[key] as unknown[]) ?? [];
			await saveDocument({
				...doc,
				legacyEditor: { ...legacy, [key]: [...prev, ...anchored] },
			});
		}
		toast.success("Region pasted");
		// `tl` belongs here now that the trim branch calls tl.addTrim: useTimeline
		// returns a fresh object each render, so memoizing on saveDocument alone
		// would paste through a callback holding a stale document.
	}, [saveDocument, tl]);

	// Copy the SELECTED pill. Reads the same arrays the lanes render, so what gets
	// copied is what the user is looking at — the old version dug into the raw
	// document with a ternary chain that mapped a trim to "zoom" and sent
	// cameraFullscreen down the speed branch, where neither could ever be found.
	const handleCopyRegion = useCallback(async () => {
		const sel = tl.selection;
		if (!sel) return;
		const { copyRegion } = await import("@/lib/ai-edition/store/regionClipboard");

		// A trim is stored in SOURCE time against a clip anchor, so there is no
		// row to clone — but there is nothing to clone either: what the user means
		// by copying a cut is its LENGTH. Paste then makes a fresh trim of that
		// length at the playhead, which is the same deal every other kind gets
		// (properties kept, position taken from the playhead).
		if (sel.kind === "trim") {
			const { coalescedTrimGroups } = await import("@/lib/ai-edition/timeline/trim-mapping");
			const group = coalescedTrimGroups(tl.trimRanges, tl.clips).find((g) =>
				g.ids.includes(sel.id),
			);
			if (!group) return;
			copyRegion({ kind: "trim", region: { durationSec: group.end - group.start } });
			setCopiedClipId(null);
			toast.success("Region copied");
			return;
		}

		if (sel.kind === "videoOverlay") return;
		const source =
			sel.kind === "zoom"
				? tl.zoomRegions
				: sel.kind === "annotation"
					? tl.annotationRegions
					: sel.kind === "speed"
						? tl.speedRegions
						: tl.cameraFullscreenRegions;
		const region = (source as Array<{ id: string }>).find((r) => r.id === sel.id);
		if (!region) return;
		copyRegion({ kind: sel.kind, region: region as unknown as Record<string, unknown> });
		// One clipboard wins at a time: a copied pill retires the copied clip.
		setCopiedClipId(null);
		toast.success("Region copied");
	}, [tl]);

	useRecordingReviewMenu({
		enabled: PRODUCT_SURFACE.recordingOnly,
		onRecord: () => void handleNewRecording(),
		onRecordings: handleOpenRecordings,
		onSave: handleExport,
	});

	useRecordingReviewShortcuts({
		enabled: PRODUCT_SURFACE.recordingOnly,
		isMac,
		playPause: shortcuts.playPause,
		onSave: handleExport,
		onRecord: () => void handleNewRecording(),
		onRecordings: handleOpenRecordings,
		onPlayPause: togglePlay,
		onStep: (direction) =>
			handleSeek(Math.max(0, useProjectStore.getState().currentTimeSec + direction / 60)),
	});

	useEffect(() => {
		if (PRODUCT_SURFACE.recordingOnly) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return;
			if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
			if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
			if (
				e.target instanceof HTMLElement &&
				e.target.closest(
					"button, a[href], select, [role='button'], [role='checkbox'], [role='combobox'], [role='menuitem'], [role='menuitemradio'], [role='radio'], [role='separator'], [role='slider'], [role='switch'], [role='tab']",
				) &&
				[
					"Enter",
					" ",
					"Tab",
					"ArrowLeft",
					"ArrowRight",
					"ArrowUp",
					"ArrowDown",
					"Home",
					"End",
					"Escape",
				].includes(e.key)
			) {
				return;
			}
			const ctrl = e.ctrlKey || e.metaKey;

			if (ctrl && e.key === "s") {
				e.preventDefault();
				void handleSave();
				return;
			}
			if (ctrl && e.key === "n") {
				e.preventDefault();
				void (async () => {
					const choice = await promptUnsaved("new");
					if (choice === "cancel") return;
					if (choice === "save") {
						const doc = useProjectStore.getState().document;
						if (doc) {
							try {
								await saveDocument(doc);
							} catch {
								return;
							}
						}
					}
					setNewProjectOpen(true);
				})();
				return;
			}
			if (ctrl && e.key === "o") {
				e.preventDefault();
				void (async () => {
					const choice = await promptUnsaved("open");
					if (choice === "cancel") return;
					if (choice === "save") {
						const doc = useProjectStore.getState().document;
						if (doc) {
							try {
								await saveDocument(doc);
							} catch {
								return;
							}
						}
					}
					setOpenProjectOpen(true);
				})();
				return;
			}
			if (!hasProject && e.key !== "?") return;
			if (ctrl && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) return;
			if (e.key === "?" || (e.shiftKey && e.key === "/")) {
				e.preventDefault();
				openShortcutsConfig();
				return;
			}

			const deleteSelection = () => {
				if (tl.clipSelection) {
					void tl.removeClip(tl.clipSelection);
					return;
				}
				// F2.7 — a shift-click multi-selection deletes as one batch (one
				// undo snapshot); a single selection keeps the original path.
				if (tl.multiSelection.length > 1) {
					void tl.removeRegions(tl.multiSelection);
					return;
				}
				if (tl.selection) {
					void tl.removeRegion(tl.selection.kind, tl.selection.id);
				}
			};

			// F2.9 — configurable actions read the user's saved bindings instead
			// of hardcoded keys, so rebinding in the shortcuts dialog actually
			// changes runtime behavior.
			if (matchesShortcut(e, shortcuts.copySelected, isMac)) {
				// A pill and a clip can no longer both be selected (see selectRegion /
				// selectClip), so this reads the one the user actually picked instead
				// of preferring clips whatever was clicked last.
				if (tl.selection) {
					e.preventDefault();
					void handleCopyRegion();
					return;
				}
				if (tl.clipSelection) {
					e.preventDefault();
					setCopiedClipId(tl.clipSelection);
					// A copied clip retires the copied pill — see clearRegionClipboard.
					void import("@/lib/ai-edition/store/regionClipboard").then((m) =>
						m.clearRegionClipboard(),
					);
					return;
				}
			}
			if (ctrl && e.key.toLowerCase() === "x") {
				// F2.8 — cut: remember the region in the clipboard, then remove it.
				// Trims included now that copying one means copying its length.
				if (tl.selection) {
					e.preventDefault();
					const cut = tl.selection;
					void handleCopyRegion().then(() => tl.removeRegion(cut.kind, cut.id));
					return;
				}
			}
			if (matchesShortcut(e, shortcuts.paste, isMac)) {
				e.preventDefault();
				// Paste what was COPIED. It used to fall back to `tl.clipSelection`,
				// so a clip merely being selected hijacked the paste — and since
				// `copiedClipId` was never cleared, one Ctrl+C on a clip turned every
				// later Ctrl+V into a clip duplication for the rest of the session,
				// whatever the user copied afterwards.
				if (copiedClipId) {
					void tl.duplicateClip(copiedClipId);
					return;
				}
				void pasteRegion();
				return;
			}
			if (matchesShortcut(e, shortcuts.playPause, isMac)) {
				e.preventDefault();
				togglePlay();
				return;
			}
			if (matchesShortcut(e, shortcuts.deleteSelected, isMac)) {
				e.preventDefault();
				deleteSelection();
				return;
			}
			if (e.key === "Delete" || e.key === "Backspace") {
				e.preventDefault();
				deleteSelection();
				return;
			}
			// Same size on screen as the toolbar buttons produce — these shortcuts are
			// what the empty lanes advertise ("Press Z to add zoom"), so they are the
			// way most regions get created. Left on the flat default they came out
			// under two pixels on a 30-minute recording, hidden behind the playhead
			// they were created at. See timeline/newRegionDuration.
			if (matchesShortcut(e, shortcuts.addZoom, isMac)) {
				e.preventDefault();
				void tl.addZoom(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addTrim, isMac)) {
				e.preventDefault();
				void tl.addTrim(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addAnnotation, isMac)) {
				e.preventDefault();
				void tl.addAnnotation(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addSpeed, isMac)) {
				e.preventDefault();
				void tl.addSpeed(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addCameraFullscreen, isMac)) {
				e.preventDefault();
				void tl.addCameraFullscreen(newRegionDurationSec());
				return;
			}

			// Keep Tab and Shift+Tab for normal focus navigation. Annotation cycling
			// uses arrow keys with Alt, which follows the platform convention that
			// arrows move inside a composite control while Tab moves between controls.
			if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
				const annotations = [...tl.annotationRegions].sort((a, b) => a.startMs - b.startMs);
				if (annotations.length > 0) {
					e.preventDefault();
					const direction = e.key === "ArrowUp" ? -1 : 1;
					const currentId = tl.selection?.kind === "annotation" ? tl.selection.id : null;
					const currentIndex = currentId ? annotations.findIndex((a) => a.id === currentId) : -1;
					const nextIndex =
						currentIndex === -1
							? direction === 1
								? 0
								: annotations.length - 1
							: (currentIndex + direction + annotations.length) % annotations.length;
					tl.selectRegion("annotation", annotations[nextIndex].id);
				}
				return;
			}
			if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				e.preventDefault();
				const frameStepSec = 1 / 60;
				const direction = e.key === "ArrowLeft" ? -1 : 1;
				const playhead = useProjectStore.getState().currentTimeSec;
				handleSeek(Math.max(0, playhead + direction * frameStepSec));
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		hasProject,
		handleCopyRegion,
		handleSave,
		pasteRegion,
		tl,
		promptUnsaved,
		saveDocument,
		copiedClipId,
		openShortcutsConfig,
		shortcuts,
		isMac,
		togglePlay,
		handleSeek,
	]);

	const showTimeline = !PRODUCT_SURFACE.recordingOnly;
	// After Stop, review opens as a small player; it can grow into the full window.
	const compactReview = useReviewWindowCompact(PRODUCT_SURFACE.recordingOnly);
	// Review is part of the recorder, which is always dark.
	useEffect(() => {
		if (PRODUCT_SURFACE.recordingOnly) applyTheme("dark");
	}, []);
	useCompactReviewFit(compactReview && hasAsset, document);
	const visibleMode = PRODUCT_SURFACE.mediaWorkspace ? mode : "edit";
	const timelineRow = visibleMode === "media" ? "188px" : `${timelineHeightPx}px`;
	const bodyColumns =
		visibleMode === "edit" && PRODUCT_SURFACE.agentEditor && chatOpen
			? `${chatWidthPx}px 1fr`
			: "1fr";

	// Drag the chat/stage divider (col-resize) or the timeline's top edge
	// (row-resize) to resize. Pointer-driven like V4Timeline's pill/nav/clip
	// drags — pointerdown arms a window-level pointermove/pointerup pair, no
	// drag library. Persisted to localStorage (a UI layout preference, not
	// project content, so it doesn't belong in the document/useEditorSettings
	// round-trip).
	const startChatResize = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = chatWidthPx;
			let latest = startWidth;
			const move = (ev: PointerEvent) => {
				latest = Math.min(560, Math.max(280, startWidth + (ev.clientX - startX)));
				setChatWidthPx(latest);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				localStorage.setItem("os-editor-chat-width", String(latest));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[chatWidthPx],
	);

	const startTimelineResize = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			const startY = e.clientY;
			const startHeight = timelineHeightPx;
			let latest = startHeight;
			const move = (ev: PointerEvent) => {
				// Dragging the handle up (negative clientY delta) enlarges the
				// timeline, since it sits below the handle.
				latest = Math.min(480, Math.max(160, startHeight - (ev.clientY - startY)));
				setTimelineHeightPx(latest);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				localStorage.setItem("os-editor-timeline-height", String(latest));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[timelineHeightPx],
	);

	const resizeChatFromKeyboard = useCallback(
		(e: ReactKeyboardEvent<HTMLDivElement>) => {
			let next = chatWidthPx;
			if (e.key === "ArrowLeft") next -= 16;
			else if (e.key === "ArrowRight") next += 16;
			else if (e.key === "Home") next = 280;
			else if (e.key === "End") next = 560;
			else return;
			e.preventDefault();
			next = Math.min(560, Math.max(280, next));
			setChatWidthPx(next);
			localStorage.setItem("os-editor-chat-width", String(next));
		},
		[chatWidthPx],
	);

	const resizeTimelineFromKeyboard = useCallback(
		(e: ReactKeyboardEvent<HTMLDivElement>) => {
			let next = timelineHeightPx;
			if (e.key === "ArrowUp") next += 16;
			else if (e.key === "ArrowDown") next -= 16;
			else if (e.key === "Home") next = 160;
			else if (e.key === "End") next = 480;
			else return;
			e.preventDefault();
			next = Math.min(480, Math.max(160, next));
			setTimelineHeightPx(next);
			localStorage.setItem("os-editor-timeline-height", String(next));
		},
		[timelineHeightPx],
	);

	const transcriptProps = {
		clips,
		transcripts: document?.transcripts ?? [],
		assets: document?.assets ?? [],
		trimRanges: document?.timeline?.trimRanges ?? [],
		busyAssetIds,
		onSeek: handleSeek,
		onAddTrimRange: handleAddTrimRange,
		onRemoveTrimRange: handleRemoveTrimRange,
		onTranscribe: handleTranscribe,
		canTranscribe: hasAsset,
		isTranscribing: transcriptGate.state === "pending",
		readOnly: true,
		blocked:
			transcriptGate.state === "blocked" && transcriptGate.reason
				? { reason: transcriptGate.reason, message: transcriptGate.message }
				: undefined,
	};
	const previewTrimRanges =
		pausePreviewSuggestions && document
			? applyPauseSuggestions(
					{ ...document, timeline: { ...document.timeline, trimRanges: tl.trimRanges } },
					pausePreviewSuggestions,
				).timeline.trimRanges
			: tl.trimRanges;
	const inspectorExpanded =
		!PRODUCT_SURFACE.recordingOnly && hasAsset && (inspectorOpen || tl.selection !== null);
	const reviewSegments = useMemo(
		() => resolvePlaybackSegments(clips, tl.trimRanges),
		[clips, tl.trimRanges],
	);
	const reviewProjection = useMemo(
		() => buildTimelinePlaybackProjection(reviewSegments, clips),
		[reviewSegments, clips],
	);
	const reviewMeta = useMemo(() => {
		if (!PRODUCT_SURFACE.recordingOnly || clips.length === 0) return null;
		const totalSec = reviewSegments.reduce(
			(sum, segment) => sum + (segment.timelineEndSec - segment.timelineStartSec),
			0,
		);
		const whole = Math.round(totalSec);
		const duration = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
		return clips.length === 1
			? te("recordingReview.metaOne", { duration })
			: te("recordingReview.metaMany", { duration, count: clips.length });
	}, [clips.length, reviewSegments, te]);

	return (
		<div
			className={v4.app}
			data-compact-review={compactReview}
			style={{
				gridTemplateRows: PRODUCT_SURFACE.recordingOnly
					? "auto 1fr 0px"
					: `var(--editor-topbar-h) 1fr ${showTimeline ? timelineRow : "0px"}`,
			}}
		>
			<TransactionRecoveryBanner />
			{PRODUCT_SURFACE.recordingOnly ? (
				<RecordingReviewToolbar
					isMac={isMac}
					interruptions={recordingInterruptions(document)}
					handoffError={recordingReviewError}
					onRetryHandoff={() => {
						void resumeRecordingWorkspace();
					}}
					title={project?.title ?? null}
					meta={reviewMeta}
					canSave={hasAsset}
					preparing={recordingReviewPending || recordingReviewActionPending !== null}
					openingRecorder={recordingReviewActionPending === "record"}
					readOnly={entitlement.access === "read-only"}
					busy={sourceExportBusy || isExportRunActive(exportRunPhase)}
					percent={sourceExportBusy ? null : (exportRun?.percent ?? null)}
					entitlementLabel={entitlementLabel}
					onEntitlement={() => openEntitlement()}
					onRecordings={handleOpenRecordings}
					onSettings={handleOpenSettings}
					onRecord={() => void handleNewRecording()}
					onSave={handleExport}
					onOriginals={() => void openRecordingExport(true)}
					onExpand={
						compactReview ? () => void window.electronAPI?.expandReviewWindow?.() : undefined
					}
				/>
			) : (
				<EditorTopBar
					mode={visibleMode}
					onModeChange={setMode}
					projectTitle={project?.title ?? null}
					dirty={dirty}
					canExport={hasAsset}
					exportRun={exportRun}
					canImportMedia={hasProject}
					canRegenerateAutomaticEdits={canRegenerateAutomaticDirection(document)}
					regeneratingAutomaticEdits={regeneratingAutomaticEdits}
					importingMedia={importingMedia}
					chatOpen={chatOpen}
					readOnly={entitlement.access === "read-only"}
					entitlementLabel={entitlementLabel}
					onEntitlement={() => openEntitlement()}
					actions={{
						openProject: () => setOpenProjectOpen(true),
						newProject: () => requireEntitlement("edit") && setNewProjectOpen(true),
						importMedia: () => void handleImportMedia(),
						save: () => requireEntitlement("edit") && void handleSave(),
						export: handleExport,
						openSettings: handleOpenSettings,
						renameProject: handleRenameProject,
						toggleChat,
						record: () => void handleNewRecording(),
						regenerateAutomaticEdits: () => void handleRegenerateAutomaticEdits(),
					}}
				/>
			)}

			<div className={v4.body} style={{ gridTemplateColumns: bodyColumns }}>
				{visibleMode === "edit" && PRODUCT_SURFACE.agentEditor && chatOpen ? (
					<>
						<aside className={v4.agent} aria-label={te("shell.aiEditor")}>
							<LeftPanel active="chat" />
						</aside>
						<div
							className={v4.chatResizeHandle}
							style={{ left: chatWidthPx }}
							role="separator"
							tabIndex={0}
							aria-orientation="vertical"
							aria-label={te("shell.resizeChatPanel")}
							aria-valuemin={280}
							aria-valuemax={560}
							aria-valuenow={chatWidthPx}
							onPointerDown={startChatResize}
							onKeyDown={resizeChatFromKeyboard}
						/>
					</>
				) : null}

				<section className={v4.stage} aria-label={te("shell.previewStage")}>
					{visibleMode === "edit" ? (
						<>
							<div
								className={v4.previewWorkspace}
								data-inspector-open={inspectorExpanded}
								data-recording-only={PRODUCT_SURFACE.recordingOnly}
							>
								{PRODUCT_SURFACE.recordingOnly && !hasAsset ? (
									<div className={v4.recordingEmpty}>
										<p>{te("recordingReview.ready")}</p>
										<button type="button" onClick={() => void handleNewRecording()}>
											{te("recordingReview.record")}
										</button>
										<span>{te("recordingReview.readyHint")}</span>
									</div>
								) : (
									<Preview
										hasProject={hasProject}
										hasAsset={hasAsset}
										readOnly={PRODUCT_SURFACE.recordingOnly}
										videoSources={videoSources}
										clips={clips}
										zoomRegions={tl.zoomRegions}
										speedRegions={tl.speedRegions}
										cameraFullscreenRegions={tl.cameraFullscreenRegions}
										trimRanges={previewTrimRanges}
										selectedZoomRegionId={
											!PRODUCT_SURFACE.recordingOnly && tl.selection?.kind === "zoom"
												? tl.selection.id
												: null
										}
										onZoomFocusChange={tl.updateZoomFocusLive}
										onZoomFocusCommit={() => void tl.commitZoomFocus()}
										annotationRegions={tl.annotationRegions}
										selectedAnnotationId={
											!PRODUCT_SURFACE.recordingOnly && tl.selection?.kind === "annotation"
												? tl.selection.id
												: null
										}
										onSelectAnnotation={
											PRODUCT_SURFACE.recordingOnly
												? undefined
												: (id) => tl.selectRegion("annotation", id)
										}
										onAnnotationPositionChange={(id, position) => {
											// Live seulement : appelé à chaque mouvement de souris pour que le
											// compositeur natif suive le geste. L'écriture disque se fait une fois,
											// au relâchement, via `onAnnotationCommit`.
											tl.updateAnnotationLive(id, { position });
										}}
										onAnnotationSizeChange={(id, size) => {
											tl.updateAnnotationLive(id, { size });
										}}
										onAnnotationBlurDataChange={(id, blurData) =>
											tl.updateAnnotationLive(id, { blurData })
										}
										onAnnotationCommit={() => void tl.commitAnnotationChange()}
										seekTarget={seekTarget}
										onTimeChange={handleTimeChange}
										onSeek={handleSeek}
										onLoadedMetadata={handleLoadedMetadata}
										onVideoElement={setVideoElement}
										playing={playing}
										screenFramingEnabled={
											inspectorExpanded && facet === "layout" && tl.selection === null
										}
									/>
								)}
								{hasAsset && !PRODUCT_SURFACE.recordingOnly ? <PreviewQualityControl /> : null}
								{PRODUCT_SURFACE.recordingOnly && hasAsset ? (
									<div className={v4.reviewTransport}>
										<TransportBar
											variant="overlay"
											playing={playing}
											overrideTimeSec={null}
											clips={reviewSegments}
											toDisplayTime={(sec) => rawTimeToPlaybackTime(sec, reviewProjection)}
											onTogglePlay={togglePlay}
											onPrevClip={handlePrevClip}
											onNextClip={handleNextClip}
											onSeek={(sec) =>
												handleSeek(playbackTimeToRawTime(sec, reviewProjection, "after"))
											}
										/>
									</div>
								) : null}
							</div>
							{!PRODUCT_SURFACE.recordingOnly ? (
								<FloatingInspector
									facet={facet}
									open={hasAsset && inspectorOpen}
									tl={tl}
									onFacetChange={(f) => {
										setFacet(f);
										setInspectorOpen(true);
									}}
									onToggleOpen={() => setInspectorOpen((v) => !v)}
									clips={tl.clips}
									onEditClip={setEditClipTarget}
									transcriptProps={transcriptProps}
									onPausePreview={handlePausePreview}
								/>
							) : null}
						</>
					) : (
						<MediaStage />
					)}
				</section>
			</div>

			{/* Timeline footer shared by the Media and Edit workspaces. */}
			{showTimeline ? (
				<div
					style={{
						position: "relative",
						gridRow: 3,
						minHeight: 0,
						background: "var(--surface)",
						borderTop: "1px solid var(--border)",
					}}
				>
					{visibleMode !== "media" ? (
						<div
							className={v4.timelineResizeHandle}
							role="separator"
							tabIndex={0}
							aria-orientation="horizontal"
							aria-label={te("shell.resizeTimeline")}
							aria-valuemin={160}
							aria-valuemax={480}
							aria-valuenow={timelineHeightPx}
							onPointerDown={startTimelineResize}
							onKeyDown={resizeTimelineFromKeyboard}
						/>
					) : null}
					<V4Timeline
						onOpenCaptions={() => {
							setFacet("captions");
							setInspectorOpen(true);
						}}
						tl={tl}
						setCurrentTime={handleSeek}
						variant={visibleMode === "media" ? "media" : "edit"}
						onDropAsset={handleDropAsset}
						videoSources={videoSources}
						pauseSuggestions={pauseSuggestions}
						onPauseSuggestionToggle={togglePauseSuggestion}
						playing={playing}
						onTogglePlay={togglePlay}
						onPrevClip={handlePrevClip}
						onNextClip={handleNextClip}
						onEditClip={setEditClipTarget}
					/>
				</div>
			) : null}

			{/* Modals */}
			<OpenProjectModal
				loading={projectListLoading}
				loadFailed={projectListFailed}
				recordingOnly={PRODUCT_SURFACE.recordingOnly}
				open={openProjectOpen}
				onClose={() => setOpenProjectOpen(false)}
				projects={projectSummaries}
				activeProjectId={projectId}
				onSelect={handleSelectProject}
				onDelete={handleDeleteProject}
				onBrowse={handleBrowseProject}
			/>
			<NewProjectModal
				open={newProjectOpen}
				onClose={() => setNewProjectOpen(false)}
				onCreate={handleCreateProject}
			/>
			<EditClipModal
				open={editClipTarget !== null}
				onClose={() => setEditClipTarget(null)}
				clip={editClipTarget}
				assetMeta={
					editClipTarget
						? {
								label:
									document?.assets.find((a) => a.id === editClipTarget.assetId)?.label ??
									editClipTarget.assetId,
								durationSec: document?.assets.find((a) => a.id === editClipTarget.assetId)
									?.durationSec,
							}
						: null
				}
				videoSources={videoSources}
				onApply={(sStart, sEnd, cropRegion) => {
					if (!editClipTarget) return;
					void tl.updateClipSourceRange(editClipTarget.id, sStart, sEnd);
					if (cropRegion !== undefined) void tl.updateClipCrop(editClipTarget.id, cropRegion);
					setEditClipTarget(null);
				}}
			/>
			<UnsavedChangesModal
				open={unsavedPrompt !== null}
				onClose={() => {
					unsavedPrompt?.resolve("cancel");
					setUnsavedPrompt(null);
				}}
				action={unsavedPrompt?.action ?? "new"}
				onChoose={handleConfirmUnsaved}
			/>
			<ExportDialog
				open={exportOpen}
				onClose={() => setExportOpen(false)}
				document={document}
				quickExport={PRODUCT_SURFACE.recordingOnly && quickExport}
				onSourceBusyChange={handleSourceExportBusyChange}
			/>
		</div>
	);
}

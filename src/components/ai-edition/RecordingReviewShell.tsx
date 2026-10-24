import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { useCleanVoiceRuntime } from "@/hooks/useCleanVoiceRuntime";
import { useReviewWindowCompact } from "@/hooks/useReviewWindowCompact";
import { applyTheme } from "@/hooks/useTheme";
import { migrateRawDocumentToCurrent } from "@/lib/ai-edition/document/migrate";
import { recordingInterruptions } from "@/lib/ai-edition/document/recordingInterruptions";
import {
	applyProbedDuration,
	replaceTimeline as replaceTimelineOp,
	resolvePlaybackSegments,
} from "@/lib/ai-edition/document/timeline";
import { usePreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import { type AxcutClip, documentSchema } from "@/lib/ai-edition/schema";
import {
	exportRunPercent,
	isExportRunActive,
	useExportRunStore,
} from "@/lib/ai-edition/store/exportRunStore";
import { useProjectStore, waitForProjectMutations } from "@/lib/ai-edition/store/projectStore";
import { useAssetDimensionBackfill } from "@/lib/ai-edition/store/useAssetDimensionBackfill";
import {
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
	rawTimeToPlaybackTime,
} from "@/lib/ai-edition/timeline/timelineMap";
import { toCleanCut } from "@/lib/cleanCut/export";
import {
	buildCleanCutReview,
	joinSegmentsByClip,
	type ReviewCut,
} from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { requireEntitlement, useEntitlementStore } from "@/lib/entitlements/store";
import { formatExportEta } from "@/lib/exporter/mp4ExportSettings";
import { ipcErrorMessage } from "@/lib/ipcErrorMessage";
import type { RecordingWorkspaceContext } from "@/lib/recordingSession";
import { nativeBridgeClient } from "@/native";
import type { AiEditionProjectSummary } from "@/native/contracts";
import { AmbientBackdrop } from "./cleanCut/AmbientBackdrop";
import { CleanCutHudPill } from "./cleanCut/CleanCutHud";
import { CleanCutStage } from "./cleanCut/CleanCutStage";
import { CleanCutWaveform } from "./cleanCut/CleanCutWaveform";
import { groupMoments, pauseCuts } from "./cleanCut/moments";
import { playbackSpans } from "./cleanCut/speechLevels";
import { type ListenMode, useCleanCutGuide } from "./cleanCut/useCleanCutGuide";
import { useCleanCutSession } from "./cleanCut/useCleanCutSession";
import { ExportDialog } from "./ExportDialog";
import { prepareLegacyProjectForOpen } from "./legacyProjectOpen";
import { OpenProjectModal, UnsavedChangesModal, type UnsavedChoice } from "./Modals";
import { Preview } from "./Preview";
import styles from "./RecordingReviewShell.module.css";
import { RecordingReviewToolbar } from "./RecordingReviewToolbar";
import { importPendingRecording, isPendingRecordingImportInProgress } from "./recordingImport";
import { createRecordingReviewNavigation } from "./recordingReviewNavigation";
import {
	awaitRecordingReviewDocument,
	hasPendingRecordingHandoff,
} from "./recordingReviewReadiness";
import { recordsIntoOpenProject, reviewInsertionTime } from "./reviewInsertion";
import { selectReviewPreviewRegions } from "./reviewPreviewRegions";
import { isPrewarmedReview } from "./reviewPrewarm";
import { TransactionRecoveryBanner } from "./TransactionRecoveryBanner";
import { TransportBar } from "./TransportBar";
import { useCompactReviewFit, useReviewOutputRatio } from "./useCompactReviewFit";
import { useRecordingReviewMenu } from "./useRecordingReviewMenu";
import { useRecordingReviewShortcuts } from "./useRecordingReviewShortcuts";
import { useRevealLatch } from "./useRevealLatch";
import { useTrialStartNotice } from "./useTrialStartNotice";
import { FIRST_FRAME_TIMEOUT_MS, useVideoFirstFrame } from "./useVideoFirstFrame";

const REVIEW_SPINNER_BARS = Array.from({ length: 12 }, (_, bar) => bar);
/** Seconds of kept material a selected cut plays before it reaches the cut. */
const CLEAN_CUT_LEAD_SEC = 2.5;
/** Seconds a With or Without replay keeps playing after the cut before it stops. */
const CLEAN_CUT_TAIL_SEC = 1.6;
/** Seconds a loop plays after the cut before it starts over. */
const CLEAN_CUT_LOOP_TAIL_SEC = 2.5;

/** One replay across a cut: with it lifted, or without it, in the preview only. */
interface Audition {
	id: string;
	mode: ListenMode;
	rawStartSec: number;
	rawEndSec: number;
	/** Starts over at the end until stopped, instead of pausing. */
	loop: boolean;
	nonce: number;
}

/**
 * The workspace fields the main process persists across a recording. Review has no
 * editor workspaces, so it always hands back the values the recording-only surface used.
 */
const REVIEW_WORKSPACE = {
	mode: "edit",
	inspectorOpen: true,
	facet: "effects",
} as const satisfies Pick<RecordingWorkspaceContext, "mode" | "inspectorOpen" | "facet">;

/** Resolves once the current DOM has reached the screen. */
const nextPaint = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);

interface SeekTarget {
	timeSec: number;
	isSource?: boolean;
	requestId: number;
}

/** The trial length set in `electron/entitlements/config.ts`, for the badge ring. */
const TRIAL_DAYS = 14;

/**
 * The review window that opens after Stop: watch the take, add a clip, record again,
 * open earlier recordings and export. Klippt is recording-only, so this is the only shell.
 */
export function RecordingReviewShell() {
	const te = useScopedT("editor");
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const dirty = useProjectStore((s) => s.dirty);
	const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
	const setSourceDuration = useProjectStore((s) => s.setSourceDuration);
	const loadProject = useProjectStore((s) => s.loadProject);
	const loadLatestProject = useProjectStore((s) => s.loadLatestProject);
	const projectLoadError = useProjectStore((s) => s.error);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	// Single source of truth for transport state: anything that needs to know or drive
	// playback reads/writes this store field, not a component-local copy.
	const playing = useProjectStore((s) => s.playing);
	const setPlaying = useProjectStore((s) => s.setPlaying);
	const entitlement = useEntitlementStore((s) => s.snapshot);
	const { routes: cleanVoiceRoutes } = useCleanVoiceRuntime(document);
	const openEntitlement = useEntitlementStore((s) => s.openDialog);
	const entitlementLabel = (() => {
		if (entitlement.reactivationRequired) return te("entitlement.status.reactivate");
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
	const firstFrameReady = useVideoFirstFrame(videoElement);
	// Covers the stage before the window hides for the recorder, so showing it
	// again never flashes the previous recording.
	const [leavingForRecorder, setLeavingForRecorder] = useState(false);
	const stageRevealed = useRevealLatch(
		projectId,
		firstFrameReady && (videoElement?.readyState ?? 0) >= HTMLMediaElement.HAVE_CURRENT_DATA,
		leavingForRecorder,
		// Also covers a missing <video> or one that never decodes: reveal what the
		// native preview has instead of a spinner that never ends.
		FIRST_FRAME_TIMEOUT_MS,
	);
	const [startupLoaded, setStartupLoaded] = useState(false);
	const deferredStartupRef = useRef<(() => void) | null>(null);
	const firstFrameShownRef = useRef(false);
	useEffect(() => {
		if (!firstFrameReady) return;
		firstFrameShownRef.current = true;
		window.electronAPI?.markStopStage?.("review-first-frame");
	}, [firstFrameReady]);
	const [recordingReviewPending, setRecordingReviewPending] = useState(false);
	const [recordingReviewError, setRecordingReviewError] = useState<string | null>(null);
	const [recordingReviewActionPending, setRecordingReviewActionPending] = useState<
		"record" | "add" | "export" | null
	>(null);
	const recordingReviewActionRef = useRef(false);
	const [openProjectOpen, setOpenProjectOpen] = useState(false);
	const [exportOpen, setExportOpen] = useState(false);
	const [quickExport, setQuickExport] = useState(true);
	const [sourceOnlyExport, setSourceOnlyExport] = useState(false);
	const [sourceExportBusy, setSourceExportBusy] = useState(false);
	const sourceExportBusyRef = useRef(false);
	const handleSourceExportBusyChange = useCallback((busy: boolean) => {
		// Menu and keyboard handlers must observe the lock before React renders.
		sourceExportBusyRef.current = busy;
		setSourceExportBusy(busy);
	}, []);
	// A background export keeps rendering after its dialog closes; the toolbar shows it.
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
	const [unsavedPrompt, setUnsavedPrompt] = useState<{
		action: "close" | "new" | "open";
		resolve: (choice: UnsavedChoice) => void;
	} | null>(null);
	const { shortcuts, isMac, openConfig: openShortcutsConfig } = useShortcuts();
	useAssetDimensionBackfill();
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
					sourceExportBusyRef.current || isExportRunActive(useExportRunStore.getState().phase),
				isPreparing: () =>
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
	const handleRetryLatestProject = useCallback(async () => {
		const navigationRevision = recordingNavigationRevisionRef.current;
		const projectAtStart = useProjectStore.getState().projectId;
		await loadLatestProject({
			canApply: () =>
				!recordingReviewNavigation.isBlocked() &&
				recordingNavigationRevisionRef.current === navigationRevision &&
				useProjectStore.getState().projectId === projectAtStart,
		});
	}, [loadLatestProject, recordingReviewNavigation]);

	// Dev-only: expose the project store so the browser preview harness can
	// seed a populated document for design QA. Tree-shaken out of prod builds.
	if (import.meta.env.DEV) {
		(window as unknown as { __osProjectStore?: typeof useProjectStore }).__osProjectStore =
			useProjectStore;
	}

	const promptUnsaved = useCallback(
		(action: "close" | "new" | "open"): Promise<UnsavedChoice> => {
			if (!dirty) return Promise.resolve("discard");
			return new Promise<UnsavedChoice>((resolve) => {
				setUnsavedPrompt({ action, resolve });
			});
		},
		[dirty],
	);

	const clips: AxcutClip[] = document?.timeline.clips ?? [];
	const hasProject = Boolean(document);
	const hasAsset = projectId !== null && (document?.assets.length ?? 0) > 0;
	const projectTitle = document?.project.title ?? null;
	const { zoomRegions, speedRegions, cameraFullscreenRegions, trimRanges } = useMemo(
		() => selectReviewPreviewRegions(document, projectId),
		[document, projectId],
	);

	const { available: cleanCutAvailable } = useCleanCutSession(projectId, clips);
	const cleanCutEnabled = useCleanCutStore((s) => s.enabled);
	const cleanCutSnapshot = useCleanCutStore((s) => s.snapshot);
	const cleanCutStrength = useCleanCutStore((s) => s.strength);
	const cleanCutRestored = useCleanCutStore((s) => s.restored);
	const cleanCutSelectedId = useCleanCutStore((s) => s.selectedId);
	const cleanCutReady = cleanCutEnabled && cleanCutSnapshot.state === "ready";
	const cleanCutReview = useMemo(
		() =>
			cleanCutReady
				? buildCleanCutReview(cleanCutSnapshot, clips, cleanCutStrength, cleanCutRestored)
				: null,
		[cleanCutReady, cleanCutSnapshot, clips, cleanCutStrength, cleanCutRestored],
	);
	// The clean cut plays through the preview as extra trims; the document never sees them.
	const previewTrimRanges = useMemo(
		() => (cleanCutReview ? [...trimRanges, ...cleanCutReview.trimRanges] : trimRanges),
		[cleanCutReview, trimRanges],
	);
	const [audition, setAudition] = useState<Audition | null>(null);
	// The preview hands over a new element at a segment seam, so a replay reads the live one.
	const videoElementRef = useRef<HTMLVideoElement | null>(null);
	const auditionNonceRef = useRef(0);
	// The preview alone hears a replay: the cut lifts or applies only for it, never for
	// the toolbar runtime, the play bar or what Save writes.
	const auditionTrimRanges = useMemo(() => {
		if (!cleanCutReview || !audition) return previewTrimRanges;
		const restored = new Set(cleanCutRestored);
		if (audition.mode === "with") restored.add(audition.id);
		else restored.delete(audition.id);
		const lifted = buildCleanCutReview(cleanCutSnapshot, clips, cleanCutStrength, restored);
		return [...trimRanges, ...lifted.trimRanges];
	}, [
		audition,
		cleanCutReview,
		cleanCutRestored,
		cleanCutSnapshot,
		clips,
		cleanCutStrength,
		previewTrimRanges,
		trimRanges,
	]);
	const cleanCutExport = useMemo(
		() =>
			cleanCutReady
				? toCleanCut(
						cleanCutSnapshot.keep,
						cleanCutSnapshot.regions,
						cleanCutStrength,
						cleanCutRestored,
					)
				: null,
		[cleanCutReady, cleanCutSnapshot, cleanCutStrength, cleanCutRestored],
	);

	// Refresh the project list while the Recordings modal is open.
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
				setCurrentTime(afterRecording ? context.insertionTimeSec : context.currentTimeSec);
			};
			try {
				if (await importPendingRecording()) {
					if (workspace) restoreWorkspace(workspace, true);
					// An open review keeps its video element, so the first-frame hook
					// does not fire again; time the added clip to the next painted frame.
					if (firstFrameShownRef.current) {
						requestAnimationFrame(() =>
							requestAnimationFrame(() =>
								window.electronAPI?.markStopStage?.("review-first-frame"),
							),
						);
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

	// A cold review window consumes a pending recording on mount. A warm one is hidden
	// while the HUD records, then consumes the hand-off when Electron shows it again.
	useEffect(() => {
		const resumeWorkspace = () => {
			const deferredStartup = deferredStartupRef.current;
			if (deferredStartup) {
				deferredStartupRef.current = null;
				deferredStartup();
				return;
			}
			void resumeRecordingWorkspace()
				.catch((error) => console.warn("[editor] could not resume recording workspace:", error))
				.finally(() => setLeavingForRecorder(false));
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

	// Auto-load the recording session, or the most recent project, on mount.
	useEffect(() => {
		if (initRef.current) return;
		initRef.current = true;
		const runStartup = () => {
			window.electronAPI?.markStopStage?.("review-startup");
			void (async () => {
				try {
					await loadStartupProject();
				} finally {
					window.electronAPI?.markStopStage?.("review-project-loaded");
					setStartupLoaded(true);
				}
			})();
		};
		// A review loaded ahead of Stop waits for the take: Electron's return event,
		// or a hand-off that was already pending when this renderer mounted.
		if (isPrewarmedReview(globalThis.location.search) && window.electronAPI) {
			deferredStartupRef.current = runStartup;
			void hasPendingRecordingHandoff(() => window.electronAPI.getCurrentRecordingSession())
				.catch(() => false)
				.then((pending) => {
					if (!pending || deferredStartupRef.current !== runStartup) return;
					deferredStartupRef.current = null;
					runStartup();
				});
			return;
		}
		runStartup();
		async function loadStartupProject() {
			if (await resumeRecordingWorkspace()) return;
			const navigationRevision = recordingNavigationRevisionRef.current;
			const projectAtStart = useProjectStore.getState().projectId;
			const canApply = () =>
				!recordingReviewNavigation.isBlocked() &&
				recordingNavigationRevisionRef.current === navigationRevision &&
				useProjectStore.getState().projectId === projectAtStart;
			// No recording waiting: restore the newest valid project without parsing the
			// whole library. The browser shim uses its seeded project order as well.
			// Reopening review after a recording lands on the project that recording went
			// into, settings and all, instead of a second project on the same file.
			try {
				console.info("[editor] auto-loading latest valid project");
				await loadLatestProject({ canApply });
				const state = useProjectStore.getState();
				console.info(
					"[editor] post-loadProject status=",
					state.status,
					"error=",
					JSON.stringify(state.error),
					"doc=",
					state.document ? "loaded" : "null",
				);
			} catch (e) {
				console.warn("[editor] auto-load failed", e);
			}
		}
	}, [loadLatestProject, recordingReviewNavigation, resumeRecordingWorkspace]);

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

	// Electron close interception: sync dirty state to the main process.
	useEffect(() => {
		if (!window.electronAPI) return;
		window.electronAPI.setHasUnsavedChanges(dirty);
	}, [dirty]);

	useEffect(() => {
		if (!window.electronAPI) return;

		// Handle request-close-confirm from Electron.
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

		// Handle request-save-before-close from Electron.
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
			// WebM recordings from MediaRecorder can report NaN/Infinity. Fall back to a
			// 60s seed if duration is unknown so the timeline never gets stuck on an empty
			// placeholder. All store reads go through getState() to avoid stale closures.
			const known = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 60;
			const state = useProjectStore.getState();
			setSourceDuration(known);
			const doc = state.document;
			if (!doc || doc.assets.length === 0) return;
			if (doc.timeline.clips.length === 0) {
				// replaceTimeline derives clip length from asset.durationSec, which import
				// never populates. Without this patch the first auto-created clip comes out
				// empty (normalizeIntervals clamps against a 0 duration and drops it).
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
			// The pure document layer patches only the clips of THIS asset that are still
			// waiting for a real length, shifts what follows, and brings the modifiers
			// along. It returns the document untouched when nothing is waiting.
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

	const handleTimeChange = useCallback(
		(timeSec: number) => {
			setCurrentTime(timeSec);
		},
		[setCurrentTime],
	);

	// Ref so the 'ended' listener below always sees the latest clips without tearing
	// down and re-registering the DOM listener on every document change. The playhead
	// is read straight off the store at call time, so the shell does not subscribe to
	// per-frame transport updates.
	const clipsForEndedRef = useRef(clips);
	clipsForEndedRef.current = clips;

	useEffect(() => {
		const el = videoElement;
		if (!el) return;
		const onPlay = () => setPlaying(true);
		const onPause = () => setPlaying(false);
		// VirtualPreview listens to the same native 'ended' event and advances to the
		// next clip. Only stop playback when no clip follows the playhead, using the
		// same test as handleNextClip.
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
		// setPlaying is a stable Zustand action reference, so listing it here doesn't
		// cause this effect to re-subscribe on every playhead tick.
	}, [videoElement, setPlaying]);

	const togglePlay = useCallback(() => {
		if (!videoElement) return;
		if (videoElement.paused) {
			// `play()` rejects on the autoplay policy or when a new load interrupts it.
			// The store's `playing` flag follows the element's own play/pause listeners,
			// so a rejection leaves nothing to reconcile; it must not escape unhandled.
			void videoElement.play().catch(() => {
				// swallow: rejection just means playback never started
			});
		} else {
			videoElement.pause();
		}
	}, [videoElement]);

	const handlePrevClip = useCallback(() => {
		if (clips.length === 0) return;
		// Navigate in virtual timeline space, not source-media time.
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

	// After Stop, a new clip goes at the end until the viewer moves the playhead;
	// from then on it goes to the clip boundary nearest the playhead. A new
	// recording or an added clip starts at the end again.
	const insertionKey = `${document?.project.id ?? ""}:${clips.length}`;
	const [playheadMovedFor, setPlayheadMovedFor] = useState<string | null>(null);
	const insertFollowsPlayhead = playheadMovedFor === insertionKey;
	const followPlayheadForInsertion = useCallback(
		() => setPlayheadMovedFor(insertionKey),
		[insertionKey],
	);
	const reviewInsertionBoundary = useCallback(
		(playheadSec: number) => {
			const current = useProjectStore.getState().document?.timeline.clips ?? [];
			return reviewInsertionTime(current, playheadSec, insertFollowsPlayhead);
		},
		[insertFollowsPlayhead],
	);

	const handleBrowseProject = useCallback(async () => {
		if (!requireEntitlement("import")) return;
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

	// The only way to get rid of a project short of deleting its file by hand.
	// Media is left alone on purpose: a recording can back several projects, and
	// the dialog says so before it asks.
	const handleDeleteProject = useCallback(
		async (id: string) => {
			if (entitlement.access === "read-only" || recordingReviewNavigation.isBlocked()) return;
			try {
				const result = await nativeBridgeClient.aiEdition.delete(id);
				if (!result.success) throw new Error(result.error ?? "Failed to delete project");
				setProjectSummaries((prev) => prev.filter((p) => p.id !== id));
				// Deleting the project that is open leaves review pointing at a file
				// that no longer exists; any save from there would recreate it.
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
		[entitlement.access, recordingReviewNavigation],
	);

	const handleConfirmUnsaved = useCallback(
		(choice: UnsavedChoice) => {
			if (!unsavedPrompt) return;
			const { resolve } = unsavedPrompt;
			setUnsavedPrompt(null);
			// Resolve the pending action when the user picks save or discard.
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

	const handleNewRecording = useCallback(
		async (target: "new" | "add" = "new") => {
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
			setRecordingReviewActionPending(target === "add" ? "add" : "record");
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
				// The review window closes during the workspace switch. Save first so
				// reopening the project is exact and never needs an unsaved-changes modal.
				if (currentDocument && state.dirty) await saveDocument(currentDocument);
				state = useProjectStore.getState();
				currentDocument = state.document;
				const context: RecordingWorkspaceContext | undefined =
					state.projectId && currentDocument && recordsIntoOpenProject(target, true)
						? {
								origin: "editor",
								projectId: state.projectId,
								insertionTimeSec: reviewInsertionBoundary(state.currentTimeSec),
								currentTimeSec: state.currentTimeSec,
								...REVIEW_WORKSPACE,
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
				setLeavingForRecorder(true);
				await nextPaint();
				const result = await api.startNewRecording(context);
				if (!result.success) {
					setLeavingForRecorder(false);
					if (result.code === "ENTITLEMENT_REQUIRED") {
						openEntitlement("record");
						return;
					}
					throw new Error(result.error ?? "Could not open recording controls");
				}
			} catch (err) {
				setLeavingForRecorder(false);
				toast.error("Could not open recording controls", {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				recordingReviewActionRef.current = false;
				setRecordingReviewActionPending(null);
			}
		},
		[openEntitlement, resumeRecordingWorkspace, reviewInsertionBoundary, saveDocument, setPlaying],
	);

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
				setSourceOnlyExport(sourceRecovery);
				setExportOpen(true);
			} catch (error) {
				toast.error(te("recordingReview.prepareFailed"), {
					description: ipcErrorMessage(error),
				});
			} finally {
				recordingReviewActionRef.current = false;
				setRecordingReviewActionPending(null);
			}
		},
		[resumeRecordingWorkspace, te],
	);
	const handleExport = useCallback(() => {
		void openRecordingExport(false);
	}, [openRecordingExport]);

	const handleOpenSettings = useCallback(() => {
		openShortcutsConfig();
	}, [openShortcutsConfig]);

	useRecordingReviewMenu({
		enabled: true,
		onRecord: () => void handleNewRecording(),
		onRecordings: handleOpenRecordings,
		onSave: handleExport,
	});

	const reviewSegments = useMemo(
		() => resolvePlaybackSegments(clips, previewTrimRanges),
		[clips, previewTrimRanges],
	);
	const uncutSegments = useMemo(
		() => (cleanCutReview ? resolvePlaybackSegments(clips, trimRanges) : reviewSegments),
		[cleanCutReview, clips, trimRanges, reviewSegments],
	);
	const reviewProjection = useMemo(
		() => buildTimelinePlaybackProjection(reviewSegments, clips),
		[reviewSegments, clips],
	);
	// The clean cut on the playback clock: seams where it jumps, and the speech that plays.
	const toPlaybackSec = useCallback(
		(rawSec: number) => rawTimeToPlaybackTime(rawSec, reviewProjection),
		[reviewProjection],
	);
	const cleanCutMoments = useMemo(
		() => (cleanCutReview ? groupMoments(cleanCutReview.strip, toPlaybackSec) : []),
		[cleanCutReview, toPlaybackSec],
	);
	const cleanCutPauses = useMemo(
		() => (cleanCutReview ? pauseCuts(cleanCutReview.strip) : []),
		[cleanCutReview],
	);
	const cleanCutSpans = useMemo(() => {
		if (!cleanCutReview) return [];
		const cutIds = new Set<string>();
		const restoredIds = new Set<string>();
		for (const cut of cleanCutReview.strip)
			(cut.restored ? restoredIds : cutIds).add(cut.region.id);
		return playbackSpans(cleanCutSnapshot.words, clips, cutIds, restoredIds, toPlaybackSec);
	}, [cleanCutReview, cleanCutSnapshot.words, clips, toPlaybackSec]);
	// Keyboard seeking moves in playback time, like the scrub bar, so trimmed
	// stretches are never a stop.
	const seekPlayback = (next: (playbackSec: number, endSec: number) => number) => {
		followPlayheadForInsertion();
		const endSec = reviewSegments.reduce(
			(sum, segment) => sum + (segment.timelineEndSec - segment.timelineStartSec),
			0,
		);
		const nowSec = rawTimeToPlaybackTime(
			useProjectStore.getState().currentTimeSec,
			reviewProjection,
		);
		const targetSec = Math.min(endSec, Math.max(0, next(nowSec, endSec)));
		handleSeek(playbackTimeToRawTime(targetSec, reviewProjection, "after"));
	};
	// After Stop, review opens as a small player; it can grow into the full window.
	const compactReview = useReviewWindowCompact(true);
	const cleanCutPanelOpen = cleanCutEnabled && !compactReview && hasAsset;
	const [cleanCutListOpen, setCleanCutListOpen] = useState(false);
	const [cleanCutCollapsed, setCleanCutCollapsed] = useState(false);
	useEffect(() => {
		if (!cleanCutPanelOpen) setCleanCutListOpen(false);
	}, [cleanCutPanelOpen]);
	const seekBeforeRaw = (rawSec: number) => {
		followPlayheadForInsertion();
		const seamSec = rawTimeToPlaybackTime(rawSec, reviewProjection);
		handleSeek(
			playbackTimeToRawTime(Math.max(0, seamSec - CLEAN_CUT_LEAD_SEC), reviewProjection, "after"),
		);
	};
	const selectCleanCut = (cut: ReviewCut) => {
		useCleanCutStore.getState().select(cut.region.id);
		seekBeforeRaw(cut.rawStartSec);
	};
	const stepCleanCut = (direction: -1 | 1) => {
		if (!cleanCutReview) return;
		const order =
			useCleanCutStore.getState().view === "transcript"
				? cleanCutReview.strip.filter((cut) => cut.region.kind !== "pause")
				: cleanCutReview.cuts;
		if (order.length === 0) return;
		const selectedId = useCleanCutStore.getState().selectedId;
		const index = order.findIndex((cut) => cut.region.id === selectedId);
		const next =
			index === -1
				? direction > 0
					? 0
					: order.length - 1
				: Math.min(order.length - 1, Math.max(0, index + direction));
		selectCleanCut(order[next]);
	};
	videoElementRef.current = videoElement;
	const auditionCut = (cut: ReviewCut, mode: ListenMode, loop: boolean) => {
		auditionNonceRef.current += 1;
		setAudition({
			id: cut.region.id,
			mode,
			rawStartSec: cut.rawStartSec,
			rawEndSec: cut.rawEndSec,
			loop,
			nonce: auditionNonceRef.current,
		});
	};
	const stopAudition = () => {
		setAudition(null);
		videoElementRef.current?.pause();
	};
	const cleanCutGuide = useCleanCutGuide({
		model: cleanCutReview,
		resetKey: `${cleanCutSnapshot.projectId}:${cleanCutSnapshot.state}:${cleanCutSnapshot.regions.length}`,
		active: cleanCutPanelOpen && !cleanCutCollapsed && !cleanCutListOpen,
		select: (cut) => {
			setAudition(null);
			selectCleanCut(cut);
		},
		audition: auditionCut,
		stop: stopAudition,
	});
	// A loop ends on its own when the viewer takes the playhead somewhere else.
	const endLoopRef = useRef(cleanCutGuide.endLoop);
	endLoopRef.current = cleanCutGuide.endLoop;
	// A replay starts once the preview has the trim it asked for, plays across the cut and
	// stops shortly after it, so each card is heard the same way.
	// biome-ignore lint/correctness/useExhaustiveDependencies: each replay runs once, by its nonce.
	useEffect(() => {
		if (!audition) return;
		const projection = buildTimelinePlaybackProjection(
			resolvePlaybackSegments(clips, auditionTrimRanges),
			clips,
		);
		// Measured on the replay's own playback clock, so the cuts it jumps never count.
		const seamSec = rawTimeToPlaybackTime(audition.rawStartSec, projection);
		const fromSec = Math.max(0, seamSec - CLEAN_CUT_LEAD_SEC);
		const fromRaw = playbackTimeToRawTime(fromSec, projection, "after");
		const stopSec =
			rawTimeToPlaybackTime(audition.rawEndSec, projection) +
			(audition.loop ? CLEAN_CUT_LOOP_TAIL_SEC : CLEAN_CUT_TAIL_SEC);
		handleSeek(fromRaw);
		void videoElementRef.current?.play().catch(() => undefined);
		let armed = false;
		const unsubscribe = useProjectStore.subscribe((state) => {
			const now = rawTimeToPlaybackTime(state.currentTimeSec, projection);
			if (!armed) armed = now >= fromSec - 0.5 && now < stopSec;
			else if (audition.loop && (now < fromSec - 1 || now > stopSec + 2)) {
				// The viewer took the playhead elsewhere: the loop lets go.
				unsubscribe();
				endLoopRef.current();
			} else if (audition.loop && now >= stopSec) {
				armed = false;
				handleSeek(fromRaw);
				void videoElementRef.current?.play().catch(() => undefined);
			} else if (now >= stopSec) {
				unsubscribe();
				videoElementRef.current?.pause();
			}
		});
		return unsubscribe;
	}, [audition?.nonce]);
	const cleanCutKeys = cleanCutPanelOpen && cleanCutReview !== null;
	const guideKeys = cleanCutKeys && !cleanCutListOpen;
	// A minimised card takes no decisions: its cut is out of sight.
	const cardHidden = guideKeys && cleanCutCollapsed;
	const cardOpen = guideKeys && !cleanCutCollapsed && cleanCutGuide.current !== null;
	useRecordingReviewShortcuts({
		enabled: true,
		isMac,
		playPause: shortcuts.playPause,
		onSave: handleExport,
		onRecord: () => void handleNewRecording(),
		onRecordings: handleOpenRecordings,
		onPlayPause: () => {
			followPlayheadForInsertion();
			// With the card up, Space plays its cut again from the lead-in; pressed while
			// playing it pauses, and ends a loop.
			if (cardOpen && videoElementRef.current?.paused) {
				cleanCutGuide.replay();
				return;
			}
			if (cardOpen && cleanCutGuide.looping) {
				cleanCutGuide.endLoop();
				stopAudition();
				return;
			}
			togglePlay();
		},
		onLoop: cardOpen ? cleanCutGuide.toggleLoop : undefined,
		onStep: (direction, unit) =>
			seekPlayback((sec) => sec + direction / (unit === "frame" ? 60 : 1)),
		onClip: (direction) => {
			followPlayheadForInsertion();
			if (direction < 0) handlePrevClip();
			else handleNextClip();
		},
		onEdge: (edge) => seekPlayback((_, endSec) => (edge === "start" ? 0 : endSec)),
		onMute: () => usePreviewAudio.getState().toggleMuted(),
		...(cleanCutKeys
			? {
					onCut: (direction) => {
						if (cardHidden) return;
						if (guideKeys) cleanCutGuide.step(direction);
						else stepCleanCut(direction);
					},
					onRestore: () => {
						if (cardHidden) return;
						if (guideKeys) {
							cleanCutGuide.restore();
							return;
						}
						const id = useCleanCutStore.getState().selectedId;
						if (id && cleanCutReview?.strip.some((cut) => cut.region.id === id))
							useCleanCutStore.getState().toggleRestore(id);
					},
					onUndo: () => useCleanCutStore.getState().undo(),
					onRedo: () => useCleanCutStore.getState().redo(),
				}
			: {}),
	});

	// Review is part of the recorder, which is always dark.
	useEffect(() => {
		applyTheme("dark");
	}, []);
	useCompactReviewFit(compactReview && hasAsset, document);
	const videoRatio = useReviewOutputRatio(document);
	useTrialStartNotice(entitlement, hasAsset, te("entitlement.trialStarted"));

	const uncutTotalSec = uncutSegments.reduce(
		(sum, segment) => sum + (segment.timelineEndSec - segment.timelineStartSec),
		0,
	);
	const reviewTotalSec = reviewSegments.reduce(
		(sum, segment) => sum + (segment.timelineEndSec - segment.timelineStartSec),
		0,
	);
	const transportSegments = useMemo(() => {
		if (!cleanCutReview) return reviewSegments;
		const rawClipOf = new Map(reviewProjection.map((part) => [part.segment.id, part.rawClipId]));
		return joinSegmentsByClip(reviewSegments, (segment) => rawClipOf.get(segment.id) ?? segment.id);
	}, [cleanCutReview, reviewSegments, reviewProjection]);

	const reviewMeta = useMemo(() => {
		if (clips.length === 0) return null;
		const totalSec = uncutSegments.reduce(
			(sum, segment) => sum + (segment.timelineEndSec - segment.timelineStartSec),
			0,
		);
		const whole = Math.round(totalSec);
		const duration = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
		return clips.length === 1
			? te("recordingReview.metaOne", { duration })
			: te("recordingReview.metaMany", { duration, count: clips.length });
	}, [clips.length, uncutSegments, te]);

	return (
		<div
			className={styles.app}
			data-compact-review={compactReview}
			data-cinema={cleanCutPanelOpen || undefined}
			data-sheet={(cleanCutPanelOpen && cleanCutListOpen) || undefined}
			data-card={
				cleanCutPanelOpen
					? cleanCutReady && cleanCutReview && !cleanCutCollapsed
						? "open"
						: "slim"
					: undefined
			}
			style={
				{
					gridTemplateRows: "auto 1fr 0px",
					"--video-ratio": videoRatio ?? 16 / 9,
				} as CSSProperties
			}
		>
			{cleanCutPanelOpen ? <AmbientBackdrop video={videoElement} /> : null}
			<TransactionRecoveryBanner />
			<RecordingReviewToolbar
				isMac={isMac}
				interruptions={recordingInterruptions(document)}
				handoffError={recordingReviewError}
				onRetryHandoff={() => {
					void resumeRecordingWorkspace();
				}}
				title={projectTitle}
				meta={reviewMeta}
				canSave={hasAsset}
				preparing={recordingReviewPending || recordingReviewActionPending !== null}
				openingRecorder={recordingReviewActionPending === "record"}
				addingClip={recordingReviewActionPending === "add"}
				readOnly={entitlement.access === "read-only"}
				busy={sourceExportBusy || isExportRunActive(exportRunPhase)}
				percent={sourceExportBusy ? null : (exportRun?.percent ?? null)}
				entitlementLabel={entitlementLabel}
				trialDays={
					entitlement.status === "trial-active" && !entitlement.reactivationRequired
						? {
								left: entitlement.trialDaysRemaining ?? 0,
								total: Math.max(TRIAL_DAYS, entitlement.trialDaysRemaining ?? 0),
							}
						: null
				}
				onEntitlement={() => openEntitlement()}
				onRecordings={handleOpenRecordings}
				onSettings={handleOpenSettings}
				onRecord={() => void handleNewRecording()}
				onAddClip={() => void handleNewRecording("add")}
				onSave={handleExport}
				onOriginals={() => void openRecordingExport(true)}
				onExpand={compactReview ? () => void window.electronAPI?.expandReviewWindow?.() : undefined}
				cleanCut={
					cleanCutAvailable
						? {
								enabled: cleanCutEnabled,
								state: cleanCutSnapshot.state,
								progress: cleanCutSnapshot.progress,
								stage: cleanCutSnapshot.stage ?? null,
								fromSec: uncutTotalSec,
								toSec: cleanCutReview ? reviewTotalSec : null,
								onToggle: () => useCleanCutStore.getState().setEnabled(!cleanCutEnabled, projectId),
							}
						: undefined
				}
			/>

			<div className={styles.body} style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
				<section
					className={styles.stage}
					aria-label={te("shell.previewStage")}
					data-cinema={cleanCutPanelOpen || undefined}
				>
					<div className={styles.previewWorkspace} data-recording-only="true">
						{!hasAsset ? (
							<div className={styles.recordingEmpty}>
								{startupLoaded && projectLoadError ? (
									<div role="alert">
										<p>{te("recordingReview.loadRecordingsFailed")}</p>
										<div
											style={{
												display: "flex",
												gap: 8,
												flexWrap: "wrap",
												justifyContent: "center",
											}}
										>
											<button type="button" onClick={() => void handleRetryLatestProject()}>
												{te("recordingReview.retryOpen")}
											</button>
											<button type="button" onClick={handleOpenRecordings}>
												{te("recordingReview.recordings")}
											</button>
										</div>
										<span style={{ maxWidth: "64ch", overflowWrap: "anywhere" }}>
											{projectLoadError}
										</span>
									</div>
								) : (
									<>
										<p>{te("recordingReview.ready")}</p>
										<button type="button" onClick={() => void handleNewRecording()}>
											{te("recordingReview.newRecording")}
										</button>
										<span>{te("recordingReview.readyHint")}</span>
									</>
								)}
							</div>
						) : (
							<Preview
								hasProject={hasProject}
								hasAsset={hasAsset}
								readOnly
								// Direct camera placement only: off for a read-only entitlement
								// and while an export reads the project.
								cameraEditable={
									entitlement.access !== "read-only" &&
									!sourceExportBusy &&
									!isExportRunActive(exportRunPhase)
								}
								videoSources={videoSources}
								clips={clips}
								zoomRegions={zoomRegions}
								speedRegions={speedRegions}
								cameraFullscreenRegions={cameraFullscreenRegions}
								trimRanges={auditionTrimRanges}
								seekTarget={seekTarget}
								onTimeChange={handleTimeChange}
								onSeek={handleSeek}
								onLoadedMetadata={handleLoadedMetadata}
								onVideoElement={setVideoElement}
								playing={playing}
							/>
						)}
						<div
							className={styles.reviewLoading}
							data-ready={!leavingForRecorder && (stageRevealed || (startupLoaded && !hasAsset))}
							data-testid="review-loading"
							aria-hidden="true"
						>
							<div className={styles.reviewSpinner}>
								{REVIEW_SPINNER_BARS.map((bar) => (
									<span
										key={bar}
										style={{
											transform: `rotate(${bar * 30}deg) translateY(-146%)`,
											animationDelay: `${bar * 0.1 - 1.2}s`,
										}}
									/>
								))}
							</div>
						</div>
						{hasAsset ? (
							<div
								className={styles.reviewTransport}
								data-overview={
									cleanCutReview === null
										? undefined
										: compactReview
											? "compact"
											: cleanCutPanelOpen
												? "full"
												: undefined
								}
							>
								<TransportBar
									variant="overlay"
									playing={playing}
									overrideTimeSec={null}
									clips={transportSegments}
									toDisplayTime={(sec) => rawTimeToPlaybackTime(sec, reviewProjection)}
									onTogglePlay={() => {
										followPlayheadForInsertion();
										togglePlay();
									}}
									onPrevClip={() => {
										followPlayheadForInsertion();
										handlePrevClip();
									}}
									onNextClip={() => {
										followPlayheadForInsertion();
										handleNextClip();
									}}
									onSeek={(sec) => {
										followPlayheadForInsertion();
										handleSeek(playbackTimeToRawTime(sec, reviewProjection, "after"));
									}}
									insertionBoundarySec={reviewInsertionBoundary}
									overview={
										cleanCutReview && compactReview ? (
											<CleanCutWaveform
												compact
												moments={cleanCutMoments}
												pauses={cleanCutPauses}
												spans={cleanCutSpans}
												totalSec={reviewTotalSec}
												selectedId={cleanCutSelectedId}
												toPlaybackSec={toPlaybackSec}
												onSelect={(cut) => {
													setCleanCutCollapsed(false);
													cleanCutGuide.show(cut);
													void window.electronAPI?.expandReviewWindow?.();
												}}
											/>
										) : cleanCutPanelOpen && cleanCutReview ? (
											<CleanCutWaveform
												moments={cleanCutMoments}
												pauses={cleanCutPauses}
												spans={cleanCutSpans}
												totalSec={reviewTotalSec}
												selectedId={cleanCutSelectedId}
												toPlaybackSec={toPlaybackSec}
												onSelect={(cut) => {
													setCleanCutCollapsed(false);
													cleanCutGuide.show(cut);
												}}
												onSeek={(sec) => {
													followPlayheadForInsertion();
													handleSeek(playbackTimeToRawTime(sec, reviewProjection, "after"));
												}}
											/>
										) : undefined
									}
								/>
							</div>
						) : null}
					</div>
				</section>
				{cleanCutPanelOpen ? (
					<CleanCutStage
						model={cleanCutReview}
						moments={cleanCutMoments}
						guide={cleanCutGuide}
						clips={clips}
						isMac={isMac}
						collapsed={cleanCutCollapsed}
						onCollapse={setCleanCutCollapsed}
						fromSec={uncutTotalSec}
						toSec={reviewTotalSec}
						toPlaybackSec={toPlaybackSec}
						listOpen={cleanCutListOpen}
						onListOpen={setCleanCutListOpen}
						saveDisabled={!hasAsset || entitlement.access === "read-only"}
						onSave={handleExport}
						onSeekRaw={(rawSec) => {
							followPlayheadForInsertion();
							handleSeek(
								playbackTimeToRawTime(
									rawTimeToPlaybackTime(rawSec, reviewProjection),
									reviewProjection,
									"after",
								),
							);
						}}
						onSelectCut={cleanCutGuide.show}
					/>
				) : null}
				{compactReview && cleanCutReady && cleanCutReview ? (
					<div className={styles.compactPill}>
						<CleanCutHudPill
							count={cleanCutReview.unsureCount}
							basic={
								cleanCutSnapshot.modelCheck === "unavailable" ||
								cleanCutSnapshot.modelCheck === "failed"
							}
							onOpen={() => void window.electronAPI?.expandReviewWindow?.()}
						/>
					</div>
				) : null}
			</div>

			<OpenProjectModal
				loading={projectListLoading}
				loadFailed={projectListFailed}
				recordingOnly
				allowDelete={entitlement.access !== "read-only"}
				allowImport={entitlement.access !== "read-only"}
				open={openProjectOpen}
				onClose={() => setOpenProjectOpen(false)}
				projects={projectSummaries}
				activeProjectId={projectId}
				onSelect={handleSelectProject}
				onDelete={handleDeleteProject}
				onBrowse={handleBrowseProject}
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
				quickExport={quickExport}
				sourceOnly={sourceOnlyExport}
				onSourceBusyChange={handleSourceExportBusyChange}
				cleanCut={cleanCutExport}
				cleanCutStatus={
					cleanCutEnabled &&
					(cleanCutSnapshot.state === "working" || cleanCutSnapshot.state === "failed")
						? cleanCutSnapshot.state
						: null
				}
			/>
		</div>
	);
}

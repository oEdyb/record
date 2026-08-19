// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a project on mount. The slot has to be emptied once that project owns the
// file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import { insertClipsAtBoundary } from "@/lib/ai-edition/document/timeline";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	applyAutomaticDirection,
	DEFAULT_AUTOMATIC_DIRECTION_POLICY,
} from "@/lib/ai-edition/timeline/automatic-direction";
import { buildMicrophoneActivitySpans } from "@/lib/ai-edition/timeline/microphone-activity";
import { nativeBridgeClient } from "@/native/client";

let pendingRecordingImportInProgress = false;
const DIRECTION_READ_TIMEOUT_MS = 500;
const DIRECTION_ANALYSIS_CONCURRENCY = 2;
const RECORDING_DIRECTION_POLICY = DEFAULT_AUTOMATIC_DIRECTION_POLICY;

/**
 * Prevents the preview's normal single-file bootstrap from racing the recorder
 * import while its assets and exact clip timeline are still being assembled.
 */
export function isPendingRecordingImportInProgress() {
	return pendingRecordingImportInProgress;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await work(items[index]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()),
	);
	return results;
}

type RecordedDirectionInput = {
	assetId: string;
	screenVideoPath: string;
	durationMs: number;
	hasCamera: boolean;
};

type RecordedScreenTelemetry = {
	assetId: string;
	cursorTelemetry: Awaited<
		ReturnType<typeof nativeBridgeClient.cursor.getRecordingData>
	>["samples"];
	keyboardActivity: NonNullable<
		Awaited<ReturnType<typeof nativeBridgeClient.cursor.getRecordingData>>["keyboardActivity"]
	>;
};

function recordedClipId(createdAt: number, index: number) {
	return `clip_recording_${createdAt}_${index + 1}`;
}

/**
 * Reuse the asset left by an interrupted import. The stable clip ID wins when
 * the transaction already committed. Otherwise the persisted recording-import
 * ID identifies the exact asset, so a retry cannot append another random-ID
 * copy or claim an unrelated manual media-library asset.
 */
async function acquireRecordedAsset(options: {
	path: string;
	label: string;
	clipId: string;
	recordingImportId: string;
}): Promise<AxcutAsset | null> {
	const document = useProjectStore.getState().document;
	const committedClip = document?.timeline.clips.find((clip) => clip.id === options.clipId);
	const committedAsset = committedClip
		? document?.assets.find((asset) => asset.id === committedClip.assetId)
		: undefined;
	if (committedAsset) return committedAsset;

	const interruptedAsset = document?.assets.find(
		(asset) =>
			asset.recordingImportId === options.recordingImportId &&
			asset.originalPath === options.path &&
			asset.label === options.label,
	);
	if (interruptedAsset) return interruptedAsset;

	const asset = await useProjectStore.getState().addAsset(options.path, options.label, {
		recordingImportId: options.recordingImportId,
	});
	return asset;
}

function createImportHistorySnapshot(
	base: AxcutDocument,
	recordingImportId: string,
	original: AxcutDocument,
): AxcutDocument {
	const ownedAssetIds = new Set(
		base.assets
			.filter((asset) => asset.recordingImportId === recordingImportId)
			.map((asset) => asset.id),
	);
	const referencedAssetIds = new Set(base.timeline.clips.map((clip) => clip.assetId));
	const assets = base.assets.filter(
		(asset) => !ownedAssetIds.has(asset.id) || referencedAssetIds.has(asset.id),
	);
	const retainedAssetIds = new Set(assets.map((asset) => asset.id));
	const basePrimaryWasRemoved = Boolean(
		base.project.primaryAssetId && !retainedAssetIds.has(base.project.primaryAssetId),
	);
	const primaryAssetId = basePrimaryWasRemoved
		? retainedAssetIds.has(original.project.primaryAssetId ?? "")
			? original.project.primaryAssetId
			: assets[0]?.id
		: base.project.primaryAssetId;
	const project = {
		...base.project,
		updatedAt: original.project.updatedAt,
		primaryAssetId,
	};
	if (!primaryAssetId) delete project.primaryAssetId;
	return { ...base, project, assets };
}

async function readRecordedScreenTelemetry(
	recordings: RecordedDirectionInput[],
): Promise<RecordedScreenTelemetry[]> {
	return mapWithConcurrency(
		recordings,
		DIRECTION_ANALYSIS_CONCURRENCY,
		async (recording): Promise<RecordedScreenTelemetry> => {
			let cursorTimeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const cursor = await Promise.race([
					nativeBridgeClient.cursor.getRecordingData(recording.screenVideoPath),
					new Promise<null>((resolve) => {
						cursorTimeout = setTimeout(() => resolve(null), DIRECTION_READ_TIMEOUT_MS);
					}),
				]);
				return {
					assetId: recording.assetId,
					cursorTelemetry: cursor?.samples ?? [],
					keyboardActivity: cursor?.keyboardActivity ?? [],
				};
			} catch (error) {
				// Direction is an enhancement, not a condition for keeping a recording.
				console.warn("[recording-import] automatic direction unavailable:", error);
				return {
					assetId: recording.assetId,
					cursorTelemetry: [],
					keyboardActivity: [],
				};
			} finally {
				if (cursorTimeout) clearTimeout(cursorTimeout);
			}
		},
	);
}

async function commitRecordedImport(options: {
	projectId: string;
	clips: AxcutClip[];
	insertionTimeSec: number;
	telemetry: RecordedScreenTelemetry[];
	planId: string;
	historyBase: AxcutDocument;
	prepareMissingAssets?: (document: AxcutDocument, missingAssetIds: Set<string>) => AxcutDocument;
}) {
	const result = await useProjectStore.getState().applyDocumentPatch(
		options.projectId,
		(document) => {
			const existingClipIds = new Set(document.timeline.clips.map((clip) => clip.id));
			const missingClips = options.clips.filter((clip) => !existingClipIds.has(clip.id));
			const missingAssetIds = new Set(missingClips.map((clip) => clip.assetId));
			const prepared =
				missingClips.length > 0 && options.prepareMissingAssets
					? options.prepareMissingAssets(document, missingAssetIds)
					: document;
			const arranged = insertClipsAtBoundary(prepared, missingClips, options.insertionTimeSec);
			return applyAutomaticDirection({
				id: options.planId,
				document: arranged,
				recordings: options.telemetry,
				phases: { screen: true, camera: false },
				policy: RECORDING_DIRECTION_POLICY,
			});
		},
		{
			createHistorySnapshot: (base) =>
				createImportHistorySnapshot(base, options.planId, options.historyBase),
			normalizeHistorySnapshots: (snapshot) =>
				createImportHistorySnapshot(snapshot, options.planId, options.historyBase),
		},
	);
	if (result === "project-changed" || result === "conflict") {
		throw new Error(
			result === "project-changed"
				? "The recording project changed before its clips could be inserted"
				: "The project kept changing while the recording clips were being inserted",
		);
	}
}

async function appendRecordedCameraDirection(
	recordings: RecordedDirectionInput[],
	screenTelemetry: RecordedScreenTelemetry[],
	projectId: string,
	planId: string,
) {
	const microphoneByAssetId = new Map(
		await mapWithConcurrency(
			recordings.filter((recording) => recording.hasCamera),
			DIRECTION_ANALYSIS_CONCURRENCY,
			async (recording) => {
				const microphone =
					(await window.electronAPI
						?.getAudioPeaks?.(recording.screenVideoPath, recording.durationMs / 1_000, "microphone")
						.catch(() => null)) ?? null;
				return [
					recording.assetId,
					microphone?.success && microphone.peaks
						? buildMicrophoneActivitySpans(
								microphone.peaks,
								recording.durationMs,
								RECORDING_DIRECTION_POLICY.microphoneActivity,
							)
						: [],
				] as const;
			},
		),
	);
	const result = await useProjectStore.getState().applyDocumentPatch(
		projectId,
		(document) =>
			applyAutomaticDirection({
				id: planId,
				document,
				recordings: screenTelemetry.map((item) => ({
					...item,
					microphoneActivity: microphoneByAssetId.get(item.assetId) ?? [],
				})),
				phases: { screen: false, camera: true },
				policy: RECORDING_DIRECTION_POLICY,
			}),
		{ coalesceIntoHistory: true },
	);
	if (result === "conflict") {
		console.warn("[recording-import] camera direction could not merge after repeated edits");
		void import("sonner").then(({ toast }) =>
			toast.error("Camera emphasis could not be added", {
				description: "The project changed repeatedly while automatic direction was finishing.",
			}),
		);
	}
}

/**
 * Imports the recording the HUD handed over. When recording started from an
 * editor project, the new sections go into that project at the saved boundary.
 * A recording started from the standalone HUD still creates a new project.
 *
 * Returns false when there is nothing pending — the caller then falls back to
 * reopening the most recent project. Throws if the import itself fails, leaving
 * the session in place so a later mount can retry it.
 */
export async function importPendingRecording(): Promise<boolean> {
	const api = window.electronAPI;
	if (!api) return false;

	const result = await api.getCurrentRecordingSession();
	const session = result.success ? result.session : undefined;
	const screenPath = session?.screenVideoPath;
	if (!session || !screenPath) return false;
	const workspaceResult = await api.getRecordingWorkspaceContext?.();
	const workspace = workspaceResult?.success ? workspaceResult.context : null;
	const directionPlanId = `recording-${session.createdAt}`;

	pendingRecordingImportInProgress = true;
	try {
		if (workspace?.projectId) {
			await useProjectStore.getState().loadProject(workspace.projectId);
			const loaded = useProjectStore.getState().document;
			if (!loaded || loaded.project.id !== workspace.projectId) {
				throw new Error("Could not reopen the project that started this recording");
			}
		} else {
			if (session.importProjectId) {
				await useProjectStore.getState().loadProject(session.importProjectId);
			}
			const reserved = useProjectStore.getState().document;
			if (!reserved || reserved.project.id !== session.importProjectId) {
				const created = await useProjectStore
					.getState()
					.createProject(`Recording ${new Date().toLocaleString()}`);
				const parked = await api.setCurrentRecordingSession({
					...session,
					importProjectId: created.project.id,
				});
				if (!parked.success) {
					throw new Error("Could not reserve the project for recording import");
				}
			}
		}
		// One completed recording import is one editor action. Capture the document
		// before any assets are added so Undo removes the complete insertion and
		// Redo restores those same assets, clips, camera offsets, and shifted edits.
		const documentBeforeImport = useProjectStore.getState().document;
		const historyBase = documentBeforeImport ? structuredClone(documentBeforeImport) : undefined;
		if (!historyBase) throw new Error("Could not capture the project before recording import");

		if (session.clips) {
			const capturedStartMsByIndex = new Map<number, number>();
			let capturedDurationMs = 0;
			for (const clip of [...session.clips].sort((a, b) => a.index - b.index)) {
				capturedStartMsByIndex.set(clip.index, capturedDurationMs);
				capturedDurationMs += clip.durationMs;
			}
			const keptClips = session.clips
				.filter((clip) => !clip.removed)
				.sort((a, b) => a.index - b.index);
			const imported = [];
			for (const clip of keptClips) {
				const label = clip.screenVideoPath.split(/[\\/]/).pop() || `Clip ${clip.index + 1}`;
				const asset = await acquireRecordedAsset({
					path: clip.screenVideoPath,
					label,
					clipId: recordedClipId(session.createdAt, clip.index),
					recordingImportId: directionPlanId,
				});
				if (asset) imported.push({ asset, clip });
			}

			const document = useProjectStore.getState().document;
			if (document && imported.length > 0) {
				let timelineStartSec = 0;
				const clips: AxcutClip[] = imported.map(({ asset, clip }) => {
					const durationSec = Math.max(0.001, clip.durationMs / 1000);
					const timelineEndSec = timelineStartSec + durationSec;
					const timelineClip = {
						id: recordedClipId(session.createdAt, clip.index),
						assetId: asset.id,
						sourceStartSec: 0,
						sourceEndSec: durationSec,
						timelineStartSec,
						timelineEndSec,
						wordRefs: [],
						origin: "system" as const,
						reason: "Recorded clip",
					};
					timelineStartSec = timelineEndSec;
					return timelineClip;
				});
				const durationByAssetId = new Map(
					imported.map(({ asset, clip }) => [asset.id, Math.max(0.001, clip.durationMs / 1000)]),
				);
				const clipByAssetId = new Map(imported.map(({ asset, clip }) => [asset.id, clip]));
				const directionRecordings = imported.map(({ asset, clip }) => ({
					assetId: asset.id,
					screenVideoPath: clip.screenVideoPath,
					durationMs: clip.durationMs,
					hasCamera: asset.cameraTrack != null && asset.cameraTrack.visible !== false,
				}));
				const telemetry = await readRecordedScreenTelemetry(directionRecordings);
				await commitRecordedImport({
					projectId: document.project.id,
					clips,
					insertionTimeSec: workspace?.insertionTimeSec ?? 0,
					telemetry,
					planId: directionPlanId,
					historyBase,
					prepareMissingAssets: (latest, missingAssetIds) => ({
						...latest,
						assets: latest.assets.map((asset) => {
							if (!missingAssetIds.has(asset.id)) return asset;
							const clip = clipByAssetId.get(asset.id);
							return {
								...asset,
								...(asset.cameraTrack && clip
									? {
											cameraTrack: {
												...asset.cameraTrack,
												offsetMs:
													asset.cameraTrack.offsetMs -
													(capturedStartMsByIndex.get(clip.index) ?? 0),
											},
										}
									: {}),
								...(durationByAssetId.has(asset.id)
									? { durationSec: durationByAssetId.get(asset.id) }
									: {}),
							};
						}),
					}),
				});
				if (directionRecordings.some((recording) => recording.hasCamera)) {
					void appendRecordedCameraDirection(
						directionRecordings,
						telemetry,
						document.project.id,
						directionPlanId,
					).catch((error) =>
						console.warn("[recording-import] camera direction unavailable:", error),
					);
				}
			}
		} else {
			const label = screenPath.split(/[\\/]/).pop() || "Recording";
			const asset = await acquireRecordedAsset({
				path: screenPath,
				label,
				clipId: recordedClipId(session.createdAt, 0),
				recordingImportId: directionPlanId,
			});
			const document = useProjectStore.getState().document;
			if (asset && document) {
				const durationSec = Math.max(0.001, asset.durationSec ?? 60);
				const recordedClip: AxcutClip = {
					id: recordedClipId(session.createdAt, 0),
					assetId: asset.id,
					sourceStartSec: 0,
					sourceEndSec: durationSec,
					timelineStartSec: 0,
					timelineEndSec: durationSec,
					wordRefs: [],
					origin: "system",
					reason: "Recorded section",
				};
				const directionRecordings = [
					{
						assetId: asset.id,
						screenVideoPath: screenPath,
						durationMs: durationSec * 1_000,
						hasCamera: asset.cameraTrack != null && asset.cameraTrack.visible !== false,
					},
				];
				const telemetry = await readRecordedScreenTelemetry(directionRecordings);
				await commitRecordedImport({
					projectId: document.project.id,
					clips: [recordedClip],
					insertionTimeSec: workspace?.insertionTimeSec ?? 0,
					telemetry,
					planId: directionPlanId,
					historyBase,
				});
				if (directionRecordings.some((recording) => recording.hasCamera)) {
					void appendRecordedCameraDirection(
						directionRecordings,
						telemetry,
						document.project.id,
						directionPlanId,
					).catch((error) =>
						console.warn("[recording-import] camera direction unavailable:", error),
					);
				}
			}
		}
		// Consumed: the recording now lives in a project. Cleared here rather than
		// after the timeline seed below so a failure down there can't hand the same
		// recording to the next editor window.
		await api.setCurrentRecordingSession(null);
		await api.setRecordingWorkspaceContext?.(null);

		// ponytail: MediaRecorder WebMs ship with duration = NaN until
		// fix-webm-duration patches the EBML header; until that flows through the
		// asset, drop a default 60s clip into the timeline so the editor isn't stuck
		// on "No clips yet" the moment the user lands in the project. Real duration
		// overwrites this when handleLoadedMetadata fires with a finite value.
		const doc = useProjectStore.getState().document;
		if (
			!workspace &&
			!session.clips &&
			doc &&
			doc.timeline.clips.length === 0 &&
			doc.assets.length > 0
		) {
			await useProjectStore
				.getState()
				.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording");
		}
		return true;
	} finally {
		pendingRecordingImportInProgress = false;
	}
}

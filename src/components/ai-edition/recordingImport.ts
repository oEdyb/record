// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a project on mount. The slot has to be emptied once that project owns the
// file. The editor can mount again after a cold start or renderer recovery, so a
// session left in place is imported AGAIN on the next mount: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { insertClipsAtBoundary } from "@/lib/ai-edition/document/timeline";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings, patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { probeVideoDimensions, probeVideoDuration } from "@/lib/ai-edition/timeline/duration";
import { isClipOwnedWebcamPath } from "@/lib/recording/capturePolicy";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { type AspectRatio, toAspectRatioToken } from "@/utils/aspectRatioUtils";

let pendingRecordingImportInProgress = false;
const RECOVERED_DURATION_CONCURRENCY = 2;
const RECOVERED_CLIP_DURATION_TIMEOUT_MS = 5_000;

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

async function resolveRecoveredClipDurations(
	clips: RecordingSessionClip[],
): Promise<Map<number, number>> {
	const provisional = clips.filter((clip) => !clip.removed && clip.provisionalDuration);
	const resolved = await mapWithConcurrency(
		provisional,
		RECOVERED_DURATION_CONCURRENCY,
		async (clip) => {
			const durationSec = await probeVideoDuration(
				toFileUrl(clip.screenVideoPath),
				RECOVERED_CLIP_DURATION_TIMEOUT_MS,
			);
			if (!durationSec) {
				throw new Error(`Could not read the recovered clip duration: ${clip.screenVideoPath}`);
			}
			return [clip.index, durationSec * 1_000] as const;
		},
	);
	return new Map(resolved);
}

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

async function commitRecordedImport(options: {
	projectId: string;
	clips: AxcutClip[];
	insertionTimeSec: number;
	planId: string;
	historyBase: AxcutDocument;
	sourceAspectRatio?: AspectRatio;
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
			return options.sourceAspectRatio &&
				document.timeline.clips.length === 0 &&
				getEditorSettings(document).aspectRatio ===
					getEditorSettings(options.historyBase).aspectRatio
				? patchEditorSettings(arranged, { aspectRatio: options.sourceAspectRatio })
				: arranged;
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

async function recordingAspectRatio(asset: AxcutAsset | undefined, matchSource: boolean) {
	if (!asset || !matchSource) return undefined;
	const dimensions =
		asset.video?.width && asset.video.height
			? asset.video
			: await probeVideoDimensions(toFileUrl(asset.originalPath));
	return dimensions
		? (toAspectRatioToken(dimensions.width, dimensions.height) ?? undefined)
		: undefined;
}

export async function importPendingRecording(): Promise<boolean> {
	const api = window.electronAPI;
	if (!api) return false;

	const result = await api.getCurrentRecordingSession();
	const session = result.success ? result.session : undefined;
	const screenPath = session?.screenVideoPath;
	if (!session || !screenPath) return false;
	const workspaceResult = await api.getRecordingWorkspaceContext?.();
	const workspace = workspaceResult?.success ? workspaceResult.context : null;
	const recordingImportId = `recording-${session.createdAt}`;

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
			const sortedClips = [...session.clips].sort((a, b) => a.index - b.index);
			const keptClips = sortedClips.filter((clip) => !clip.removed);
			const recoveredDurationMsByIndex = await resolveRecoveredClipDurations(keptClips);
			const durationMsForClip = (clip: RecordingSessionClip) =>
				recoveredDurationMsByIndex.get(clip.index) ?? clip.durationMs;
			const capturedStartMsByIndex = new Map<number, number>();
			let capturedDurationMs = 0;
			for (const clip of sortedClips) {
				capturedStartMsByIndex.set(clip.index, capturedDurationMs);
				capturedDurationMs += durationMsForClip(clip);
			}
			const imported: Array<{
				asset: AxcutAsset;
				clip: RecordingSessionClip;
				durationMs: number;
			}> = [];
			for (const clip of keptClips) {
				const label = clip.screenVideoPath.split(/[\\/]/).pop() || `Clip ${clip.index + 1}`;
				const asset = await acquireRecordedAsset({
					path: clip.screenVideoPath,
					label,
					clipId: recordedClipId(session.createdAt, clip.index),
					recordingImportId: recordingImportId,
				});
				if (asset) imported.push({ asset, clip, durationMs: durationMsForClip(clip) });
			}

			const document = useProjectStore.getState().document;
			if (document && imported.length > 0) {
				let timelineStartSec = 0;
				const clips: AxcutClip[] = imported.map(({ asset, clip, durationMs }) => {
					const durationSec = Math.max(0.001, durationMs / 1000);
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
					imported.map(({ asset, durationMs }) => [asset.id, Math.max(0.001, durationMs / 1000)]),
				);
				const clipByAssetId = new Map(imported.map(({ asset, clip }) => [asset.id, clip]));
				await commitRecordedImport({
					projectId: document.project.id,
					clips,
					insertionTimeSec: workspace?.insertionTimeSec ?? 0,
					planId: recordingImportId,
					historyBase,
					sourceAspectRatio: await recordingAspectRatio(imported[0]?.asset, !workspace?.projectId),
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
												// One continuous camera file spans every clip, so a later
												// clip must seek past the clips captured before it. A
												// per-clip camera file already starts with its clip.
												offsetMs: isClipOwnedWebcamPath(
													clip.screenVideoPath,
													asset.cameraTrack.sourcePath,
												)
													? asset.cameraTrack.offsetMs
													: asset.cameraTrack.offsetMs -
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
			}
		} else {
			const label = screenPath.split(/[\\/]/).pop() || "Recording";
			const asset = await acquireRecordedAsset({
				path: screenPath,
				label,
				clipId: recordedClipId(session.createdAt, 0),
				recordingImportId: recordingImportId,
			});
			const document = useProjectStore.getState().document;
			if (asset && document) {
				const durationSec =
					asset.durationSec != null && Number.isFinite(asset.durationSec) && asset.durationSec > 0
						? asset.durationSec
						: await probeVideoDuration(
								toFileUrl(asset.originalPath),
								RECOVERED_CLIP_DURATION_TIMEOUT_MS,
							);
				if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
					throw new Error(`Could not read the recording duration: ${asset.originalPath}`);
				}
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
				await commitRecordedImport({
					projectId: document.project.id,
					clips: [recordedClip],
					insertionTimeSec: workspace?.insertionTimeSec ?? 0,
					planId: recordingImportId,
					historyBase,
					sourceAspectRatio: await recordingAspectRatio(asset, !workspace?.projectId),
					prepareMissingAssets: (latest, missingAssetIds) => ({
						...latest,
						assets: latest.assets.map((current) =>
							current.id === asset.id && missingAssetIds.has(current.id)
								? { ...current, durationSec }
								: current,
						),
					}),
				});
			}
		}
		// Consumed: the recording now lives in a project. Cleared here rather than
		// after the timeline seed below so a failure down there can't hand the same
		// recording to the next editor window.
		const consumed = await api.setCurrentRecordingSession(null);
		if (!consumed.success) {
			throw new Error(
				`Could not consume the recording recovery handoff: ${consumed.error ?? "unknown error"}`,
			);
		}
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

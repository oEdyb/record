import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	regenerateAutomaticDirection as buildRegeneratedDirection,
	DEFAULT_AUTOMATIC_DIRECTION_POLICY,
	type RecordedDirectionObservation,
} from "@/lib/ai-edition/timeline/automatic-direction";
import { buildMicrophoneActivitySpans } from "@/lib/ai-edition/timeline/microphone-activity";
import { nativeBridgeClient } from "@/native/client";

const ANALYSIS_CONCURRENCY = 2;

type RecordedSource = {
	assetId: string;
	path: string;
	durationMs: number;
	hasCamera: boolean;
};

export type RegeneratedDirectionResult = {
	screenZooms: number;
	cameraEmphasis: number;
	recordings: number;
};

function recordedSources(document: AxcutDocument): RecordedSource[] {
	const clipsByAsset = new Map<string, typeof document.timeline.clips>();
	for (const clip of document.timeline.clips) {
		const clips = clipsByAsset.get(clip.assetId) ?? [];
		clips.push(clip);
		clipsByAsset.set(clip.assetId, clips);
	}
	return document.assets.flatMap((asset) => {
		if (!asset.recordingImportId || !asset.originalPath) return [];
		const clips = clipsByAsset.get(asset.id) ?? [];
		if (clips.length === 0) return [];
		const durationMs = Math.round(
			Math.max(0, ...clips.map((clip) => clip.sourceEndSec ?? clip.sourceStartSec)) * 1_000,
		);
		if (durationMs <= 0) return [];
		return [
			{
				assetId: asset.id,
				path: asset.originalPath,
				durationMs,
				hasCamera: asset.cameraTrack != null && asset.cameraTrack.visible !== false,
			},
		];
	});
}

function sourceFingerprint(sources: RecordedSource[]): string {
	return JSON.stringify(
		[...sources]
			.sort((left, right) => left.assetId.localeCompare(right.assetId))
			.map(({ assetId, path, durationMs, hasCamera }) => [assetId, path, durationMs, hasCamera]),
	);
}

async function mapWithConcurrency<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await work(items[index]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(ANALYSIS_CONCURRENCY, items.length) }, () => worker()),
	);
	return results;
}

export function canRegenerateAutomaticDirection(document: AxcutDocument | null): boolean {
	return document ? recordedSources(document).length > 0 : false;
}

async function readObservations(
	sources: RecordedSource[],
): Promise<RecordedDirectionObservation[]> {
	return mapWithConcurrency(sources, async (source) => {
		const cursor = await nativeBridgeClient.cursor.getRecordingData(source.path);
		let microphoneActivity: RecordedDirectionObservation["microphoneActivity"] = [];
		if (source.hasCamera) {
			const audioApi = window.electronAPI?.getAudioPeaks;
			if (!audioApi) throw new Error("Microphone analysis is unavailable in this build");
			const microphone = await audioApi(source.path, source.durationMs / 1_000, "microphone");
			if (!microphone.success || !microphone.peaks) {
				throw new Error("The isolated microphone track could not be read");
			}
			microphoneActivity = buildMicrophoneActivitySpans(
				microphone.peaks,
				source.durationMs,
				DEFAULT_AUTOMATIC_DIRECTION_POLICY.microphoneActivity,
			);
		}
		return {
			assetId: source.assetId,
			cursorTelemetry: cursor.samples,
			keyboardActivity: cursor.keyboardActivity ?? [],
			microphoneActivity,
		};
	});
}

/**
 * Re-run current direction policy against the media already in the project.
 * Analysis finishes before the single undoable document patch starts, so a
 * failed sidecar read cannot remove the user's existing automatic edits.
 */
export async function regenerateProjectAutomaticDirection(
	projectId: string,
): Promise<RegeneratedDirectionResult> {
	const initial = useProjectStore.getState().document;
	if (!initial || initial.project.id !== projectId) throw new Error("No recording project is open");
	const sources = recordedSources(initial);
	if (sources.length === 0) throw new Error("This project has no recorded direction data");
	const analyzedSourceFingerprint = sourceFingerprint(sources);
	const observations = await readObservations(sources);
	if (
		observations.every(
			(observation) =>
				observation.cursorTelemetry.length === 0 &&
				(observation.keyboardActivity?.length ?? 0) === 0 &&
				(observation.microphoneActivity?.length ?? 0) === 0,
		)
	) {
		throw new Error("No cursor, typing, or microphone activity was found");
	}

	const planId = `regenerated-${Date.now()}`;
	let counts = { screenZooms: 0, cameraEmphasis: 0, recordings: sources.length };
	const result = await useProjectStore.getState().applyDocumentPatch(
		projectId,
		(document) => {
			if (sourceFingerprint(recordedSources(document)) !== analyzedSourceFingerprint) {
				throw new Error("The project recordings changed during analysis. Regenerate again");
			}
			const next = buildRegeneratedDirection({
				id: planId,
				document,
				recordings: observations,
				policy: DEFAULT_AUTOMATIC_DIRECTION_POLICY,
			});
			counts = {
				screenZooms: next.zoomRanges.filter((region) => region.source === "auto").length,
				cameraEmphasis: (
					((next.legacyEditor as Record<string, unknown> | null)?.cameraFullscreenRegions as
						| Array<{ source?: string }>
						| undefined) ?? []
				).filter((region) => region.source === "auto").length,
				recordings: sources.length,
			};
			return next;
		},
		{ createHistorySnapshot: (base) => structuredClone(base) },
	);
	if (result === "project-changed") throw new Error("The open project changed during analysis");
	if (result === "conflict") throw new Error("The project kept changing during regeneration");
	return counts;
}

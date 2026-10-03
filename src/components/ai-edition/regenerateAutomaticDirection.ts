import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	type AutomaticDirectionPolicy,
	regenerateAutomaticDirection as buildRegeneratedDirection,
	DEFAULT_AUTOMATIC_DIRECTION_POLICY,
	type RecordedDirectionObservation,
} from "@/lib/ai-edition/timeline/automatic-direction";
import {
	readAutomaticDirectionSettings,
	writeAutomaticDirectionSettings,
} from "@/lib/ai-edition/timeline/automatic-direction-settings";
import { buildMicrophoneActivitySpans } from "@/lib/ai-edition/timeline/microphone-activity";
import { nativeBridgeClient } from "@/native/client";

const ANALYSIS_CONCURRENCY = 2;

type RecordedSource = {
	assetId: string;
	path: string;
	durationMs: number;
	hasCamera: boolean;
};

type RawRecordedDirectionObservation = Omit<RecordedDirectionObservation, "microphoneActivity"> & {
	durationMs: number;
	microphonePeaks?: Float32Array;
};

export interface RegenerateAutomaticDirectionOptions {
	policy?: AutomaticDirectionPolicy;
	presetId?: string | null;
	/** The first live tuning change creates history. Later changes in the same session do not. */
	createHistorySnapshot?: boolean;
	refreshObservations?: boolean;
}

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
	policy: AutomaticDirectionPolicy,
): Promise<RecordedDirectionObservation[]> {
	const raw = await readRawObservations(sources);
	return raw.map((observation) => ({
		assetId: observation.assetId,
		cursorTelemetry: observation.cursorTelemetry,
		keyboardActivity: observation.keyboardActivity,
		microphoneActivity: observation.microphonePeaks
			? buildMicrophoneActivitySpans(
					observation.microphonePeaks,
					observation.durationMs,
					policy.microphoneActivity,
				)
			: [],
	}));
}

export async function readProjectDirectionObservations(
	document: AxcutDocument,
	policy: AutomaticDirectionPolicy,
) {
	const sources = recordedSources(document);
	if (!sources.length) throw new Error("This project has no recorded direction data");
	return readObservations(sources, policy);
}

const observationCache = new Map<string, Promise<RawRecordedDirectionObservation[]>>();

export function clearAutomaticDirectionObservationCache(): void {
	observationCache.clear();
}

async function loadRawObservations(
	sources: RecordedSource[],
): Promise<RawRecordedDirectionObservation[]> {
	return mapWithConcurrency(sources, async (source) => {
		const cursor = await nativeBridgeClient.cursor.getRecordingData(source.path);
		let microphonePeaks: Float32Array | undefined;
		if (source.hasCamera) {
			const audioApi = window.electronAPI?.getAudioPeaks;
			if (!audioApi) throw new Error("Microphone analysis is unavailable in this build");
			const microphone = await audioApi(source.path, source.durationMs / 1_000, "microphone");
			if (!microphone.success || !microphone.peaks) {
				throw new Error("The isolated microphone track could not be read");
			}
			microphonePeaks = microphone.peaks;
		}
		return {
			assetId: source.assetId,
			durationMs: source.durationMs,
			cursorTelemetry: cursor.samples,
			keyboardActivity: cursor.keyboardActivity ?? [],
			microphonePeaks,
		};
	});
}

function readRawObservations(
	sources: RecordedSource[],
): Promise<RawRecordedDirectionObservation[]> {
	const key = sourceFingerprint(sources);
	const cached = observationCache.get(key);
	if (cached) return cached;
	const loading = loadRawObservations(sources).catch((error) => {
		observationCache.delete(key);
		throw error;
	});
	observationCache.set(key, loading);
	while (observationCache.size > 4) {
		const oldest = observationCache.keys().next().value;
		if (typeof oldest !== "string") break;
		observationCache.delete(oldest);
	}
	return loading;
}

/**
 * Re-run current direction policy against the media already in the project.
 * Analysis finishes before the single undoable document patch starts, so a
 * failed sidecar read cannot remove the user's existing automatic edits.
 */
export async function regenerateProjectAutomaticDirection(
	projectId: string,
	options: RegenerateAutomaticDirectionOptions = {},
): Promise<RegeneratedDirectionResult> {
	const initial = useProjectStore.getState().document;
	if (!initial || initial.project.id !== projectId) throw new Error("No recording project is open");
	const sources = recordedSources(initial);
	if (sources.length === 0) throw new Error("This project has no recorded direction data");
	const analyzedSourceFingerprint = sourceFingerprint(sources);
	if (options.refreshObservations) clearAutomaticDirectionObservationCache();
	const storedSettings = readAutomaticDirectionSettings(initial);
	const policy = options.policy ?? storedSettings.policy ?? DEFAULT_AUTOMATIC_DIRECTION_POLICY;
	const presetId = options.presetId === undefined ? storedSettings.presetId : options.presetId;
	const observations = await readObservations(sources, policy);
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
			const directed = buildRegeneratedDirection({
				id: planId,
				document,
				recordings: observations,
				policy,
			});
			const next = writeAutomaticDirectionSettings(directed, { policy, presetId });
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
		options.createHistorySnapshot === false
			? undefined
			: { createHistorySnapshot: (base) => structuredClone(base) },
	);
	if (result === "project-changed") throw new Error("The open project changed during analysis");
	if (result === "conflict") throw new Error("The project kept changing during regeneration");
	return counts;
}

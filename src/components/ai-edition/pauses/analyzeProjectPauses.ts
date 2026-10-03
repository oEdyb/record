import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	analyzeClipPauses,
	type PauseAnalysisPolicy,
	type PauseSuggestion,
} from "@/lib/ai-edition/timeline/pause-analysis";
import { buildScreenActivitySpans } from "@/lib/ai-edition/timeline/screen-activity";
import { nativeBridgeClient } from "@/native/client";

export interface ProjectPauseAnalysisResult {
	suggestions: PauseSuggestion[];
	analyzedClipCount: number;
	missingTranscript: boolean;
	missingMicrophone: boolean;
	missingSpeechActivity: boolean;
	usedMixedAudio: boolean;
}

export async function loadPeaks(
	path: string,
	durationSec: number,
	track: "mixed" | "microphone" | "system",
): Promise<Float32Array | null> {
	const api = window.electronAPI?.getAudioPeaks;
	if (!api) return null;
	const result = await api(path, durationSec, track, "analysis");
	return result.success && result.peaks ? result.peaks : null;
}

export async function loadSpeechActivity(path: string): Promise<{
	probabilities: Float32Array;
	cleanedProbabilities: Float32Array | null;
	frameSec: number;
} | null> {
	const api = window.electronAPI?.getSpeechActivity;
	if (!api) return null;
	const result = await api(path);
	return result.success && result.probabilities && result.frameSec
		? {
				probabilities: result.probabilities,
				cleanedProbabilities: result.cleanedProbabilities ?? null,
				frameSec: result.frameSec,
			}
		: null;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Analyze each source asset once, then plan clip-anchored suggestions from the
 * cached observations. The function owns no editor state, so policy changes can
 * cancel and restart it without creating partial document edits.
 */
export async function analyzeProjectPauses(
	document: AxcutDocument,
	policy: PauseAnalysisPolicy,
	signal?: AbortSignal,
): Promise<ProjectPauseAnalysisResult> {
	const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
	const transcripts = new Map(
		document.transcripts.map((transcript) => [transcript.assetId, transcript]),
	);
	const result: ProjectPauseAnalysisResult = {
		suggestions: [],
		analyzedClipCount: 0,
		missingTranscript: false,
		missingMicrophone: false,
		missingSpeechActivity: false,
		usedMixedAudio: false,
	};
	const observations = new Map<
		string,
		{
			microphonePeaks: Float32Array;
			speechProbabilities: Float32Array | null;
			cleanedSpeechProbabilities: Float32Array | null;
			speechFrameSec: number | undefined;
			systemPeaks: Float32Array | null;
			screenActivity: ReturnType<typeof buildScreenActivitySpans>;
		}
	>();

	for (const clip of document.timeline.clips) {
		throwIfAborted(signal);
		const asset = assets.get(clip.assetId);
		const durationSec = asset?.durationSec;
		if (!asset || !durationSec || durationSec <= 0) continue;
		const transcript =
			transcripts.get(asset.id) ??
			(document.transcript?.assetId === asset.id ? document.transcript : null);
		if (policy.mode === "speech" && !transcript) result.missingTranscript = true;

		let observation = observations.get(asset.id);
		if (!observation) {
			let microphonePeaks = await loadPeaks(asset.originalPath, durationSec, "microphone");
			if (!microphonePeaks && policy.mode === "audio-level") {
				microphonePeaks = await loadPeaks(asset.originalPath, durationSec, "mixed");
				result.usedMixedAudio = microphonePeaks !== null;
			}
			throwIfAborted(signal);
			if (!microphonePeaks) {
				result.missingMicrophone = true;
				continue;
			}
			const speechActivity =
				policy.mode === "speech"
					? await loadSpeechActivity(asset.originalPath).catch(() => null)
					: null;
			throwIfAborted(signal);
			if (policy.mode === "speech" && !speechActivity) {
				result.missingSpeechActivity = true;
				continue;
			}
			const [systemPeaks, cursorData] = await Promise.all([
				policy.protectSystemAudio
					? loadPeaks(asset.originalPath, durationSec, "system").catch(() => null)
					: Promise.resolve(null),
				policy.protectScreenActivity
					? nativeBridgeClient.cursor.getRecordingData(asset.originalPath).catch(() => null)
					: Promise.resolve(null),
			]);
			throwIfAborted(signal);
			observation = {
				microphonePeaks,
				speechProbabilities: speechActivity?.probabilities ?? null,
				cleanedSpeechProbabilities: speechActivity?.cleanedProbabilities ?? null,
				speechFrameSec: speechActivity?.frameSec,
				systemPeaks,
				screenActivity: buildScreenActivitySpans(cursorData, durationSec),
			};
			observations.set(asset.id, observation);
		}

		result.suggestions.push(
			...analyzeClipPauses(
				{
					clip,
					durationSec,
					microphonePeaks: observation.microphonePeaks,
					speechProbabilities: observation.speechProbabilities,
					cleanedSpeechProbabilities: observation.cleanedSpeechProbabilities,
					speechFrameSec: observation.speechFrameSec,
					systemPeaks: observation.systemPeaks,
					transcript,
					screenActivity: observation.screenActivity,
					existingTrims: document.timeline.trimRanges,
				},
				policy,
			),
		);
		result.analyzedClipCount += 1;
	}
	result.suggestions.sort((left, right) => left.timelineStartSec - right.timelineStartSec);
	return result;
}

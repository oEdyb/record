import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	type EdgeSilencePolicy,
	type EdgeSilenceSuggestion,
	isDeadAirTrim,
	planEdgeSilence,
} from "@/lib/ai-edition/timeline/edge-silence";
import { loadPeaks, loadSpeechActivity } from "./analyzeProjectPauses";

export interface ProjectEdgeAnalysisResult {
	suggestions: EdgeSilenceSuggestion[];
	analyzedClipCount: number;
	missingSpeechActivity: string[];
	missingMicrophone: string[];
	existingEdgeTrimIds: string[];
}

/**
 * Load each source's speech envelope and microphone peaks once, then plan the
 * dead-air cuts of every take. Reports which assets lack an envelope or a mic
 * track instead of guessing from mixed audio.
 */
export async function analyzeProjectEdges(
	document: AxcutDocument,
	policy: EdgeSilencePolicy,
): Promise<ProjectEdgeAnalysisResult> {
	const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
	const transcripts = new Map(
		document.transcripts.map((transcript) => [transcript.assetId, transcript]),
	);
	const envelopes = new Map<string, Awaited<ReturnType<typeof loadSpeechActivity>>>();
	const peaks = new Map<string, Float32Array | null>();
	const result: ProjectEdgeAnalysisResult = {
		suggestions: [],
		analyzedClipCount: 0,
		missingSpeechActivity: [],
		missingMicrophone: [],
		existingEdgeTrimIds: document.timeline.trimRanges.filter(isDeadAirTrim).map((trim) => trim.id),
	};
	for (const clip of document.timeline.clips) {
		const asset = assets.get(clip.assetId);
		const durationSec = asset?.durationSec;
		if (!asset || !durationSec || durationSec <= 0) continue;
		const clipLengthSec = (clip.sourceEndSec ?? durationSec) - clip.sourceStartSec;
		if (clipLengthSec > policy.maximumClipSec) continue;
		if (!envelopes.has(asset.id)) {
			const envelope = await loadSpeechActivity(asset.originalPath).catch(() => null);
			envelopes.set(asset.id, envelope);
			if (!envelope) result.missingSpeechActivity.push(asset.id);
		}
		if (policy.minimumGapSec > 0 && !peaks.has(asset.id)) {
			const microphone = await loadPeaks(asset.originalPath, durationSec, "microphone").catch(
				() => null,
			);
			peaks.set(asset.id, microphone);
			if (!microphone) result.missingMicrophone.push(asset.id);
		}
		const envelope = envelopes.get(asset.id);
		if (!envelope) continue;
		result.suggestions.push(
			...planEdgeSilence(
				{
					clip,
					durationSec,
					speechProbabilities: envelope.probabilities,
					cleanedSpeechProbabilities: envelope.cleanedProbabilities,
					transcript:
						transcripts.get(asset.id) ??
						(document.transcript?.assetId === asset.id ? document.transcript : null),
					speechFrameSec: envelope.frameSec,
					microphonePeaks: peaks.get(asset.id) ?? null,
					existingTrims: document.timeline.trimRanges,
				},
				policy,
			),
		);
		result.analyzedClipCount += 1;
	}
	return result;
}

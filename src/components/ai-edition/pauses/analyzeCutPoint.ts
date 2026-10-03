import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	type CutEdge,
	type CutPointPolicy,
	type CutPointResult,
	planCutPoint,
} from "@/lib/ai-edition/timeline/cut-point";
import { loadPeaks, loadSpeechActivity } from "./analyzeProjectPauses";

export interface CutPointRequest {
	clipId: string;
	timeSec: number;
	edge: CutEdge;
}

export interface CutPointAnalysis extends CutPointResult {
	clipId: string;
	assetId: string;
	missingMicrophone: boolean;
	missingSpeechActivity: boolean;
}

export async function analyzeCutPoint(
	document: AxcutDocument,
	request: CutPointRequest,
	policy: CutPointPolicy,
): Promise<CutPointAnalysis> {
	const clip = document.timeline.clips.find((candidate) => candidate.id === request.clipId);
	if (!clip) throw new Error(`CLIP_NOT_FOUND: ${request.clipId}`);
	const asset = document.assets.find((candidate) => candidate.id === clip.assetId);
	if (!asset?.durationSec) throw new Error(`ASSET_UNAVAILABLE: ${clip.assetId}`);
	const transcript =
		document.transcripts.find((candidate) => candidate.assetId === asset.id) ??
		(document.transcript?.assetId === asset.id ? document.transcript : null);
	if (!transcript) throw new Error("TRANSCRIPT_MISSING: Run transcribe first.");
	const [microphonePeaks, speech] = await Promise.all([
		loadPeaks(asset.originalPath, asset.durationSec, "microphone").catch(() => null),
		loadSpeechActivity(asset.originalPath).catch(() => null),
	]);
	return {
		clipId: clip.id,
		assetId: asset.id,
		missingMicrophone: !microphonePeaks,
		missingSpeechActivity: !speech,
		...planCutPoint(
			{
				clip,
				durationSec: asset.durationSec,
				timeSec: request.timeSec,
				edge: request.edge,
				words: transcript.words,
				microphonePeaks,
				speechProbabilities: speech?.probabilities ?? null,
				speechFrameSec: speech?.frameSec,
			},
			policy,
		),
	};
}

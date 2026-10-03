import {
	type CheckRequest,
	type CheckResult,
	checkRules,
	runChecks,
	summarizeChecks,
} from "@/lib/ai-edition/checks";
import { type AudioObservation, buildResolvedEdit } from "@/lib/ai-edition/checks/context";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { DEFAULT_CUT_POINT_POLICY } from "@/lib/ai-edition/timeline/cut-point";
import { quietSpans } from "@/lib/ai-edition/timeline/pause-analysis";
import { loadPeaks, loadSpeechActivity } from "./analyzeProjectPauses";

export interface CheckProgress {
	result: CheckResult;
	audio: { ready: number; pending: number };
	timings: { elapsedMs: number; peaksMs: number; speechMs: number };
}
let active = 0;
const waiting: (() => void)[] = [];
async function withAudioSlot(work: () => Promise<void>) {
	await new Promise<void>((resolve) => {
		const start = () => {
			active++;
			resolve();
		};
		if (active < 2) start();
		else waiting.push(start);
	});
	try {
		await work();
	} finally {
		active--;
		waiting.shift()?.();
	}
}

export async function analyzeProjectChecks(
	document: AxcutDocument,
	request: CheckRequest,
	files: Readonly<Record<string, boolean | null>>,
	progress?: (value: CheckProgress) => void,
	signal?: AbortSignal,
) {
	const started = performance.now();
	const context = buildResolvedEdit(document, { files });
	const selected = checkRules.filter((rule) => !request.rule || rule.id === request.rule);
	const structural = runChecks(
		context,
		request,
		selected.filter((rule) => !rule.audio),
	);
	const selectedAudio = selected.filter((rule) => rule.audio);
	const assetIds = new Set(context.fragments.map((fragment) => fragment.assetId));
	const assets = selectedAudio.length
		? document.assets.filter((asset) => asset.durationSec && assetIds.has(asset.id))
		: [];
	const results: CheckResult[] = [structural];
	if (selectedAudio.some((rule) => rule.id === "cut.mid-sentence") && !request.deep)
		structural.notes.push(
			"Speech activity is disabled by default; use --deep for cached Silero analysis. Cut checks use microphone peaks and transcripts.",
		);
	let ready = 0;
	let peaksMs = 0;
	let speechMs = 0;
	const publish = () => {
		const result = summarizeChecks(results, selected, request);
		progress?.({
			result,
			audio: { ready, pending: assets.length - ready },
			timings: { elapsedMs: performance.now() - started, peaksMs, speechMs },
		});
		return result;
	};
	publish();
	await Promise.all(
		assets.map((asset) =>
			withAudioSlot(async () => {
				if (signal?.aborted) return;
				// Let the first reply and unrelated broker requests leave before media work.
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (signal?.aborted) return;
				const duration = asset.durationSec ?? 0;
				const peaksStart = performance.now();
				const microphonePeaks = await loadPeaks(asset.originalPath, duration, "microphone").catch(
					() => null,
				);
				peaksMs += performance.now() - peaksStart;
				if (signal?.aborted) return;
				const speechStart = performance.now();
				const speech =
					request.deep && selectedAudio.some((rule) => rule.id === "cut.mid-sentence")
						? await loadSpeechActivity(asset.originalPath).catch(() => null)
						: null;
				speechMs += performance.now() - speechStart;
				if (signal?.aborted) return;
				const audio = new Map<string, AudioObservation>([
					[
						asset.id,
						{
							microphonePeaks,
							quietSpans: quietSpans(
								microphonePeaks,
								duration,
								DEFAULT_CUT_POINT_POLICY.sensitivity,
							),
							speechProbabilities: speech?.probabilities,
							speechFrameSec: speech?.frameSec,
						},
					],
				]);
				const result = runChecks(
					{
						...context,
						audio,
						audioAssets: new Set([asset.id]),
						fragments: context.fragments.filter((fragment) => fragment.assetId === asset.id),
					},
					request,
					selectedAudio,
				);
				if (request.deep && selectedAudio.some((rule) => rule.id === "cut.mid-sentence") && !speech)
					result.notes.push(
						`cut.mid-sentence: speech activity unavailable for ${asset.id}; using peaks/transcript fallback.`,
					);
				results.push(result);
				ready++;
				publish();
			}),
		),
	);
	return publish();
}

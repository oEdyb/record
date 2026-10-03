import type { SceneSpeedRegion } from "../../../native/sceneDescription";
import { buildExportTimeMap } from "../../exporter/mp4ExportSettings";
import type { AxcutClip } from "../schema";
import { segmentRawSpanSec } from "./timelineMap";

export interface AudioClockSpan {
	rawStart: number;
	rawEnd: number;
	outputStart: number;
	outputEnd: number;
}

export function buildAudioOutputClock(
	clips: AxcutClip[],
	rawClips: AxcutClip[],
	speeds: SceneSpeedRegion[],
): AudioClockSpan[] {
	const starts = clips.map((clip) => segmentRawSpanSec(clip, rawClips).startSec);
	return buildExportTimeMap(
		clips.map((clip) => ({
			sourceStartSec: clip.sourceStartSec,
			sourceEndSec: clip.sourceEndSec ?? clip.sourceStartSec,
		})),
		speeds,
	).map((span) => ({
		rawStart: starts[span.clipIndex] + span.sourceStartSec - clips[span.clipIndex].sourceStartSec,
		rawEnd: starts[span.clipIndex] + span.sourceEndSec - clips[span.clipIndex].sourceStartSec,
		outputStart: span.outputStartSec,
		outputEnd: span.outputEndSec,
	}));
}

/** No allocations while playing. Removed gaps map to their join, as in the native timeline. */
export function audioOutputTime(raw: number, spans: readonly AudioClockSpan[]): number {
	if (!Number.isFinite(raw) || !spans.length) return 0;
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (spans[mid].rawEnd < raw) low = mid + 1;
		else high = mid;
	}
	if (low === spans.length) return spans[spans.length - 1].outputEnd;
	const span = spans[low];
	if (raw <= span.rawStart) return span.outputStart;
	return (
		span.outputStart +
		((raw - span.rawStart) / (span.rawEnd - span.rawStart)) * (span.outputEnd - span.outputStart)
	);
}

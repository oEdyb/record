import type { CursorRecordingData } from "../native/contracts";
import type { RecordingSessionClip } from "./recordingSession";

/** Align capture telemetry to the first encoded frame without keeping pre-roll input events. */
export function shiftCursorRecordingToVideoStart(
	recording: CursorRecordingData,
	offsetMs: number,
): CursorRecordingData {
	if (!Number.isFinite(offsetMs) || offsetMs <= 0) return recording;
	const shiftedSamples = recording.samples
		.filter((sample) => sample.timeMs >= offsetMs)
		.map((sample) => ({ ...sample, timeMs: sample.timeMs - offsetMs }));
	const hasStartSample = shiftedSamples.some((sample) => sample.timeMs === 0);
	const seed = !hasStartSample
		? recording.samples.filter((sample) => sample.timeMs < offsetMs).at(-1)
		: undefined;
	return {
		...recording,
		samples: [
			...(seed ? [{ ...seed, timeMs: 0, interactionType: "move" as const }] : []),
			...shiftedSamples,
		].sort((left, right) => left.timeMs - right.timeMs),
		keyboardActivity: (recording.keyboardActivity ?? [])
			.filter((sample) => sample.timeMs >= offsetMs)
			.map((sample) => ({ ...sample, timeMs: sample.timeMs - offsetMs }))
			.sort((left, right) => left.timeMs - right.timeMs),
	};
}

/** Remove paused intervals and rebase both pointer and keyboard activity to kept time. */
export function compactCursorRecordingPauseRanges(
	recording: CursorRecordingData,
	ranges: Array<{ startMs: number; endMs: number }>,
): CursorRecordingData {
	const normalizedRanges = ranges
		.map((range) => ({
			startMs: Math.max(0, Math.min(range.startMs, range.endMs)),
			endMs: Math.max(0, Math.max(range.startMs, range.endMs)),
		}))
		.filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs))
		.filter((range) => range.endMs > range.startMs)
		.sort((left, right) => left.startMs - right.startMs);
	if (normalizedRanges.length === 0) return recording;

	const compact = <T extends { timeMs: number }>(items: T[]) =>
		items.flatMap((item) => {
			let pausedBeforeMs = 0;
			for (const range of normalizedRanges) {
				if (item.timeMs >= range.startMs && item.timeMs <= range.endMs) return [];
				if (item.timeMs > range.endMs) pausedBeforeMs += range.endMs - range.startMs;
			}
			return [{ ...item, timeMs: Math.max(0, item.timeMs - pausedBeforeMs) }];
		});
	return {
		...recording,
		samples: compact(recording.samples).sort((left, right) => left.timeMs - right.timeMs),
		keyboardActivity: compact(recording.keyboardActivity ?? []).sort(
			(left, right) => left.timeMs - right.timeMs,
		),
	};
}

/** Total duration that the user has kept, excluding Backspace-removed clips. */
export function getKeptRecordingDurationMs(clips: RecordingSessionClip[]): number {
	return clips.reduce(
		(total, clip) => total + (clip.removed ? 0 : Math.max(0, clip.durationMs)),
		0,
	);
}

export function getNativeMacRecordingIdFromClipPath(videoPath: string): number | null {
	const fileName = videoPath.split(/[\\/]/).at(-1) ?? "";
	const match = fileName.match(/^recording-(\d+)-clip-\d+\.[^.]+$/i);
	if (!match) return null;
	const recordingId = Number(match[1]);
	return Number.isSafeInteger(recordingId) ? recordingId : null;
}

export function mergeNativeMacStoppedClips(
	stopped: RecordingSessionClip[],
	known: RecordingSessionClip[],
): RecordingSessionClip[] {
	const knownByIndex = new Map(known.map((clip) => [clip.index, clip]));
	return stopped
		.map((clip) => {
			const previous = knownByIndex.get(clip.index);
			return {
				...clip,
				...(previous?.removed ? { removed: true } : {}),
				...(previous?.cursorCaptureMode ? { cursorCaptureMode: previous.cursorCaptureMode } : {}),
			};
		})
		.sort((a, b) => a.index - b.index);
}

export function removePreviousNativeMacClip(clips: RecordingSessionClip[]): {
	clips: RecordingSessionClip[];
	removed?: RecordingSessionClip;
} {
	const target = [...clips].reverse().find((clip) => !clip.removed);
	if (!target) return { clips };
	const removed = { ...target, removed: true as const };
	return {
		clips: clips.map((clip) => (clip.index === target.index ? removed : clip)),
		removed,
	};
}

export function splitCursorRecordingForClips(
	recording: CursorRecordingData,
	clips: RecordingSessionClip[],
): Array<{ clip: RecordingSessionClip; recording: CursorRecordingData }> {
	const splitTimedItems = <T extends { timeMs: number }>(
		items: T[],
		startMs: number,
		endMs: number,
		includeEnd: boolean,
	) =>
		items
			.filter(
				(item) =>
					item.timeMs >= startMs && (includeEnd ? item.timeMs <= endMs : item.timeMs < endMs),
			)
			.map((item) => ({ ...item, timeMs: Math.max(0, item.timeMs - startMs) }));
	let clipStartMs = 0;
	return clips.map((clip, position) => {
		const clipEndMs = clipStartMs + clip.durationMs;
		const isLast = position === clips.length - 1;
		const samples = splitTimedItems(recording.samples, clipStartMs, clipEndMs, isLast);
		const keyboardActivity = splitTimedItems(
			recording.keyboardActivity ?? [],
			clipStartMs,
			clipEndMs,
			isLast,
		);
		clipStartMs = clipEndMs;
		return { clip, recording: { ...recording, samples, keyboardActivity } };
	});
}

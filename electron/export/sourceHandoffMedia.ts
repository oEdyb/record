import { resolveFfmpeg } from "../media/audioPeaks";
import { parseSourceAudioLayout, type SourceAudioLayout } from "../stt/sourceAudio";
import { runRecordingFfmpeg } from "./recordingFastExport";

export function parseHandoffSourceMedia(stderr: string): SourceAudioLayout {
	const layout = parseSourceAudioLayout(stderr);
	const input = stderr.split(/^Stream mapping:/m, 1)[0] ?? stderr;
	if (!/^Input #0, matroska,webm, from /m.test(input) || layout.durationSec === null) return layout;
	const start = /^\s*Duration:[^\n]*, start: ([-+]?\d+(?:\.\d+)?)/m.exec(input);
	if (!start) return { ...layout, durationSec: null };
	// FFmpeg's Matroska muxer stores the last packet end timestamp as Duration.
	// Remove positive lead-in only. Negative preroll is outside zero-based media
	// time; subtracting it would invent available material. MOV/MP4 already stores
	// an elapsed duration and must not receive this adjustment.
	const durationSec = layout.durationSec - Math.max(0, Number(start[1]));
	return {
		...layout,
		durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
	};
}

/** Header inspection only: no media output, decoding or re-encoding. */
export async function inspectHandoffSourceMedia(sourcePath: string): Promise<SourceAudioLayout> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable for source export.");
	const stderr = await runRecordingFfmpeg(
		ffmpeg,
		["-i", sourcePath, "-map", "0:v?", "-map", "0:a?", "-t", "0", "-c", "copy", "-f", "null", "-"],
		new AbortController().signal,
		10_000,
	);
	return parseHandoffSourceMedia(stderr);
}

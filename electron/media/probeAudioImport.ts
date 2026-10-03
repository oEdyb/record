import { inspectSourceAudioLayout } from "../stt/sourceAudio";

/** Reuse the bounded bundled-FFmpeg header probe. Actual decoding remains a
 * preview/export gate; a valid container header is not proof of complete media.
 * https://ffmpeg.org/ffmpeg.html#Stream-selection
 */
export async function probeAudioImport(sourcePath: string): Promise<number> {
	const layout = await inspectSourceAudioLayout(sourcePath);
	if (
		!layout.hasAudio ||
		layout.durationSec === null ||
		!Number.isFinite(layout.durationSec) ||
		layout.durationSec <= 0 ||
		layout.durationSec > 10_800
	)
		throw new Error("Select an audio file with a known duration of at most three hours");
	return layout.durationSec;
}

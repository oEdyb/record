import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeMonoPcm16k } from "../cleanCut/ffmpegPcm";
import { encodePcm16Wav } from "../cleanCut/wav";

const SR = 16_000;

/** What the review window reports for one cut (renderer method "cut.source"). */
export interface CutSource {
	id: string;
	/** The audio the engine listened to: the microphone file, or the recording itself. */
	audioPath: string;
	/** Seconds to subtract from source time to land in `audioPath`. */
	offsetSec: number;
	removedStartSec: number;
	removedEndSec: number;
	/** This asset's kept stretches with every active cut applied, in source time. */
	keep: Array<{ startSec: number; endSec: number }>;
}

export interface CutAudioRequest {
	ffmpeg: string;
	source: CutSource;
	padSec: number;
	outDir: string;
	transcriber:
		| (() => Promise<{
				transcribe(request: { id: string; audioPath: string; language?: string }): Promise<{
					words: Array<{ word: string }>;
				}>;
		  }>)
		| null;
}

/**
 * Two WAVs around a cut, so an agent can check it without playing audio aloud: `before` is the
 * source as recorded, `after` is what the edit plays, with every active cut in the window
 * applied. Each comes with its transcript when a transcriber is available.
 */
export async function renderCutAudio(request: CutAudioRequest) {
	const { source, padSec } = request;
	const pcm = await decodeMonoPcm16k(request.ffmpeg, source.audioPath);
	const fromSec = Math.max(0, source.removedStartSec - padSec);
	const toSec = source.removedEndSec + padSec;
	const slice = (start: number, end: number) =>
		pcm.subarray(
			Math.max(0, Math.round((start - source.offsetSec) * SR)),
			Math.max(0, Math.round((end - source.offsetSec) * SR)),
		);

	const before = slice(fromSec, toSec);
	const pieces: Float32Array[] = [];
	for (const span of source.keep) {
		const start = Math.max(span.startSec, fromSec);
		const end = Math.min(span.endSec, toSec);
		if (end > start) pieces.push(slice(start, end));
	}
	const after = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const piece of pieces) {
		after.set(piece, at);
		at += piece.length;
	}

	await mkdir(request.outDir, { recursive: true });
	const stem = path.join(request.outDir, source.id.replace(/[^\w.-]+/g, "_"));
	const beforePath = `${stem}-before.wav`;
	const afterPath = `${stem}-after.wav`;
	await writeFile(beforePath, encodePcm16Wav(before, SR));
	await writeFile(afterPath, encodePcm16Wav(after, SR));

	let beforeText: string | null = null;
	let afterText: string | null = null;
	if (request.transcriber) {
		const transcriber = await request.transcriber();
		const read = async (file: string, id: string) =>
			(await transcriber.transcribe({ id, audioPath: file, language: "en" })).words
				.map((w) => w.word)
				.join(" ");
		beforeText = await read(beforePath, `agent-${source.id}-before`);
		afterText = after.length ? await read(afterPath, `agent-${source.id}-after`) : "";
	}
	return {
		id: source.id,
		windowSourceSec: [fromSec, toSec],
		before: { path: beforePath, seconds: before.length / SR, text: beforeText },
		after: { path: afterPath, seconds: after.length / SR, text: afterText },
	};
}

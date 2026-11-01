import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { runRecordingFfmpeg } from "../export/recordingFastExport";
import type { PlannedItem } from "../export/sourceTimeline";
import { resolveFfmpeg } from "../media/audioPeaks";
import {
	CLEAN_AUDIO_RATE,
	type CleanAudioPiece,
	type CleanAudioPlan,
	planCleanAudio,
} from "./cleanAudioPlan";

interface PcmFile {
	handle: FileHandle;
	channels: number;
	start: number;
	samples: number;
}

async function openPcm(file: string): Promise<PcmFile> {
	const handle = await fs.open(file, "r");
	try {
		const header = Buffer.alloc(40);
		let at = 12;
		let channels = 0;
		const size = (await handle.stat()).size;
		while (at + 8 <= size) {
			await handle.read(header, 0, 8, at);
			const length = header.readUInt32LE(4);
			const kind = header.toString("ascii", 0, 4);
			if (kind === "fmt ") {
				await handle.read(header, 0, 16, at + 8);
				channels = header.readUInt16LE(2);
				if (header.readUInt32LE(4) !== CLEAN_AUDIO_RATE || header.readUInt16LE(14) !== 32)
					throw new Error("Unexpected decoded dialogue format.");
			}
			if (kind === "data" && channels > 0)
				return {
					handle,
					channels,
					start: at + 8,
					samples: Math.floor(Math.min(length, size - at - 8) / (channels * 4)),
				};
			at += 8 + length + (length % 2);
		}
		throw new Error("Missing decoded dialogue PCM.");
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function readPcm(pcm: PcmFile, start: number, count: number): Promise<Float64Array> {
	const out = new Float64Array(count * pcm.channels);
	const from = Math.max(0, start);
	const to = Math.min(pcm.samples, start + count);
	if (to <= from) return out;
	const bytes = Buffer.alloc((to - from) * pcm.channels * 4);
	let done = 0;
	while (done < bytes.length) {
		const { bytesRead } = await pcm.handle.read(
			bytes,
			done,
			bytes.length - done,
			pcm.start + from * pcm.channels * 4 + done,
		);
		if (!bytesRead) throw new Error("Incomplete decoded dialogue PCM.");
		done += bytesRead;
	}
	for (let i = 0; i < bytes.length / 4; i++)
		out[(from - start) * pcm.channels + i] = bytes.readFloatLE(i * 4);
	return out;
}

function wavHeader(samples: number, channels: number): Buffer {
	const bytes = samples * channels * 3;
	if (bytes > 0xffffffff - 36) throw new Error("Clean dialogue exceeds the WAV size limit.");
	const header = Buffer.alloc(44);
	header.write("RIFF");
	header.writeUInt32LE(bytes + 36, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(CLEAN_AUDIO_RATE, 24);
	header.writeUInt32LE(CLEAN_AUDIO_RATE * channels * 3, 28);
	header.writeUInt16LE(channels * 3, 32);
	header.writeUInt16LE(24, 34);
	header.write("data", 36);
	header.writeUInt32LE(bytes, 40);
	return header;
}

export async function renderCleanAudio(request: {
	items: PlannedItem[];
	retained: PlannedItem[];
	directory: string;
	output: string;
	signal?: AbortSignal;
}) {
	const signal = request.signal ?? new AbortController().signal;
	signal.throwIfAborted();
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable for clean dialogue.");
	const staging = await fs.mkdtemp(path.join(path.dirname(request.output), ".clean-dialogue-"));
	const files = new Map<string, PcmFile>();
	let output: FileHandle | undefined;
	let created = false;
	try {
		for (const item of request.items) {
			if (item.type === "gap" || files.has(item.file)) continue;
			const decoded = path.join(staging, `${files.size}.wav`);
			await runRecordingFfmpeg(
				ffmpeg,
				[
					"-v",
					"error",
					"-i",
					path.join(request.directory, item.file),
					"-map",
					"0:a:0",
					"-vn",
					"-ar",
					String(CLEAN_AUDIO_RATE),
					"-c:a",
					"pcm_f32le",
					"-rf64",
					"auto",
					decoded,
				],
				signal,
				60 * 60_000,
			);
			files.set(item.file, await openPcm(decoded));
		}
		const channels = files.values().next().value?.channels;
		if (!channels) throw new Error("No isolated microphone audio to render.");
		if ([...files.values()].some((file) => file.channels !== channels))
			throw new Error("Microphone channel counts differ between takes.");
		const plan = planCleanAudio(request.items, request.retained);
		output = await fs.open(request.output, "wx");
		created = true;
		await output.writeFile(wavHeader(plan.totalSamples, channels));
		let peak = 0;
		let attenuatedSeams = 0;
		const readPiece = async (piece: CleanAudioPiece, at: number, count: number) =>
			piece.type === "gap"
				? new Float64Array(count * channels)
				: readPcm(files.get(piece.file)!, piece.sourceSample + at - piece.outSample, count);
		const write = async (data: Float64Array) => {
			signal.throwIfAborted();
			const bytes = Buffer.alloc(data.length * 3);
			for (let i = 0; i < data.length; i++) {
				peak = Math.max(peak, Math.abs(data[i]));
				bytes.writeIntLE(
					Math.max(-8388608, Math.min(8388607, Math.round(data[i] * 8388608))),
					i * 3,
					3,
				);
			}
			await output!.writeFile(bytes);
		};
		let pieceIndex = 0;
		const copy = async (from: number, to: number) => {
			let at = from;
			while (at < to) {
				const piece = plan.pieces[pieceIndex];
				if (at >= piece.outSample + piece.samples) {
					pieceIndex++;
					continue;
				}
				const count = Math.min(16_384, to - at, piece.outSample + piece.samples - at);
				await write(await readPiece(piece, at, count));
				at += count;
			}
		};
		let position = 0;
		for (const seam of plan.seams) {
			const lo = seam.outSample - Math.floor(seam.fadeSamples / 2);
			await copy(position, lo);
			const a = plan.pieces[seam.left];
			const b = plan.pieces[seam.right];
			const left = await readPiece(a, lo, seam.fadeSamples);
			const right = await readPiece(b, lo, seam.fadeSamples);
			const blended = blendCleanAudio(seam, left, right, channels);
			if (blended.attenuated) attenuatedSeams++;
			await write(blended.samples);
			position = lo + seam.fadeSamples;
		}
		await copy(position, plan.totalSamples);
		return {
			file: path.basename(request.output),
			sampleRate: CLEAN_AUDIO_RATE,
			samples: plan.totalSamples,
			channels,
			peak,
			attenuatedSeams,
			plan,
		};
	} catch (error) {
		await output?.close();
		output = undefined;
		if (created) await fs.rm(request.output, { force: true });
		throw error;
	} finally {
		await output?.close();
		for (const file of files.values()) await file.handle.close();
		await fs.rm(staging, { recursive: true, force: true });
	}
}

export function blendCleanAudio(
	seam: CleanAudioPlan["seams"][number],
	left: Float64Array,
	right: Float64Array,
	channels: number,
) {
	const samples = new Float64Array(left.length);
	const lo = seam.outSample - Math.floor(seam.fadeSamples / 2);
	let peak = 0;
	for (let i = 0; i < seam.fadeSamples; i++) {
		const t = i / Math.max(1, seam.fadeSamples - 1);
		for (let c = 0; c < channels; c++) {
			const index = i * channels + c;
			const out = lo + i;
			const value =
				seam.mode === "blend"
					? left[index] * Math.cos((t * Math.PI) / 2) + right[index] * Math.sin((t * Math.PI) / 2)
					: out < seam.outSample
						? left[index] * Math.cos((Math.min(1, (i + 1) / (seam.outSample - lo)) * Math.PI) / 2)
						: right[index] *
							Math.sin(
								(((out - seam.outSample) /
									Math.max(1, lo + seam.fadeSamples - seam.outSample - 1)) *
									Math.PI) /
									2,
							);
			samples[index] = value;
			peak = Math.max(peak, Math.abs(value));
		}
	}
	if (peak > 1) for (let i = 0; i < samples.length; i++) samples[i] /= peak;
	return { samples, attenuated: peak > 1 };
}

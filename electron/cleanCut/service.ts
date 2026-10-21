import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SR } from "./acoustics";
import { planCleanCut } from "./engine";
import { decodeMonoPcm16k } from "./ffmpegPcm";
import { ParakeetHesitationVetter, type WordTranscriber } from "./parakeetVetter";
import { type PlanView, viewPlan } from "./snapshot";
import type { CleanCutTake, DecisionModel, SpokenWord, WordTime } from "./types";
import { encodePcm16Wav } from "./wav";

const CHUNK_SEC = 300;

export type CleanCutState = "off" | "working" | "ready" | "failed";
/** Whether Claude checked the cut: not installed, or its calls failed, leaves a rules-only cut. */
export type CleanCutModelCheck = "done" | "unavailable" | "failed";

export interface CleanCutSnapshot extends PlanView {
	projectId: string | null;
	state: CleanCutState;
	progress: number | null;
	error: string | null;
	rawDurationSec: number | null;
	modelCheck: CleanCutModelCheck | null;
}

/** One recording to clean: the audio the engine reads and where its times sit in the source. */
export interface CleanCutMedia {
	assetId: string;
	audioPath: string;
	offsetSec: number;
}

export interface CleanCutTranscriber extends WordTranscriber {
	transcribe(request: { id: string; audioPath: string; language?: string }): Promise<{
		words: SpokenWord[];
	}>;
	align?(request: {
		id: string;
		audioPath: string;
		words: SpokenWord[];
		alignerModels: string;
	}): Promise<{ words: WordTime[] }>;
	stop(): void;
}

export interface CleanCutServiceDeps {
	ffmpegPath: () => string | null;
	/** Starts the local recognizer, downloading its model first when needed. */
	transcriber: () => Promise<CleanCutTranscriber>;
	/** The forced aligner's model folder, or null to place cuts on recognizer times. */
	alignerModels?: () => Promise<string | null>;
	model: () => DecisionModel | null;
	tempDir: string;
	cacheDir: string;
	onSnapshot: (snapshot: CleanCutSnapshot) => void;
	decode?: typeof decodeMonoPcm16k;
	plan?: typeof planCleanCut;
}

const EMPTY: CleanCutSnapshot = {
	projectId: null,
	state: "off",
	progress: null,
	error: null,
	rawDurationSec: null,
	modelCheck: null,
	keep: [],
	regions: [],
	words: [],
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function wordCachePath(cacheDir: string, file: string) {
	const info = await stat(file);
	const key = createHash("sha1")
		.update(`${path.resolve(file)}|${info.size}|${info.mtimeMs}`)
		.digest("hex")
		.slice(0, 16);
	return path.join(cacheDir, "words", `${key}.json`);
}

/**
 * Runs the clean cut for one project at a time, off the review screen. A new start or a cancel
 * supersedes the run in flight; a superseded run never publishes again.
 */
export class CleanCutService {
	private run = 0;
	private current: CleanCutSnapshot = EMPTY;

	constructor(private readonly deps: CleanCutServiceDeps) {}

	snapshot(): CleanCutSnapshot {
		return this.current;
	}

	cancel() {
		this.run += 1;
		this.current = { ...EMPTY, projectId: this.current.projectId };
		this.deps.onSnapshot(this.current);
	}

	start(projectId: string, media: CleanCutMedia[], rawDurationSec: number): Promise<void> {
		const run = ++this.run;
		const publish = (partial: Partial<CleanCutSnapshot>) => {
			if (run !== this.run) return false;
			this.current = { ...this.current, ...partial };
			this.deps.onSnapshot(this.current);
			return true;
		};
		this.current = { ...EMPTY, projectId, rawDurationSec, state: "working", progress: 0 };
		this.deps.onSnapshot(this.current);
		return this.execute(projectId, media, run, publish).catch((error) => {
			publish({ state: "failed", progress: null, error: message(error) });
		});
	}

	private async execute(
		projectId: string,
		media: CleanCutMedia[],
		run: number,
		publish: (partial: Partial<CleanCutSnapshot>) => boolean,
	) {
		if (!media.length) throw new Error("This project has no recording to clean.");
		const ffmpeg = this.deps.ffmpegPath();
		if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable.");
		const scratch = path.join(this.deps.tempDir, `run-${process.pid}-${run}`);
		await mkdir(scratch, { recursive: true });
		let transcriber: CleanCutTranscriber | null = null;
		try {
			const takes: CleanCutTake[] = [];
			for (const [index, item] of media.entries()) {
				const step = (fraction: number) =>
					publish({ progress: ((index + fraction) / media.length) * 0.6 });
				const pcm = await (this.deps.decode ?? decodeMonoPcm16k)(ffmpeg, item.audioPath);
				if (run !== this.run) return;
				step(0.1);
				const cachePath = await wordCachePath(this.deps.cacheDir, item.audioPath);
				let words = await readFile(cachePath, "utf8")
					.then((text) => JSON.parse(text) as SpokenWord[])
					.catch(() => null);
				const wav = path.join(scratch, `take-${index}.wav`);
				await writeFile(wav, encodePcm16Wav(pcm, SR));
				if (!words) {
					transcriber ??= await this.deps.transcriber();
					words = await this.transcribe(transcriber, pcm, wav, scratch, item.assetId);
					await mkdir(path.dirname(cachePath), { recursive: true });
					await writeFile(cachePath, JSON.stringify(words));
				}
				if (run !== this.run) return;
				step(0.6);
				const alignerModels = await this.deps.alignerModels?.();
				let alignedTimes: WordTime[] | undefined;
				if (alignerModels) {
					transcriber ??= await this.deps.transcriber();
					const aligned = await transcriber.align?.({
						id: `align-${index}`,
						audioPath: wav,
						words,
						alignerModels,
					});
					alignedTimes = aligned?.words.map(({ startSec, endSec }) => ({ startSec, endSec }));
				}
				if (run !== this.run) return;
				step(1);
				const info = await stat(item.audioPath);
				takes.push({
					id: item.assetId,
					folder: path.basename(path.dirname(item.audioPath)),
					key: path.basename(item.audioPath, path.extname(item.audioPath)),
					recordedAtMs: info.birthtimeMs,
					pcm,
					words,
					alignedTimes,
				});
			}
			transcriber ??= await this.deps.transcriber();
			const model = this.deps.model();
			const plan = await (this.deps.plan ?? planCleanCut)({
				takes,
				model,
				vetter: new ParakeetHesitationVetter(transcriber, path.join(scratch, "vet")),
			});
			const view = viewPlan(
				plan,
				media.map((item, index) => ({
					assetId: item.assetId,
					offsetSec: item.offsetSec,
					words: takes[index]!.words,
				})),
			);
			const modelCheck: CleanCutModelCheck = !model
				? "unavailable"
				: plan.skipped.some((step) => step.includes("model"))
					? "failed"
					: "done";
			publish({ ...view, projectId, state: "ready", progress: 1, error: null, modelCheck });
		} finally {
			transcriber?.stop();
			await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Long recordings go to the recognizer in five-minute pieces, like the prototype. */
	private async transcribe(
		transcriber: CleanCutTranscriber,
		pcm: Float32Array,
		wav: string,
		scratch: string,
		id: string,
	): Promise<SpokenWord[]> {
		const length = pcm.length / SR;
		if (length <= 2 * CHUNK_SEC) {
			return (await transcriber.transcribe({ id, audioPath: wav, language: "en" })).words;
		}
		const words: SpokenWord[] = [];
		for (let start = 0; start <= length; start += CHUNK_SEC) {
			const piece = path.join(scratch, `${id}-${start}.wav`);
			const slice = pcm.subarray(Math.round(start * SR), Math.round((start + CHUNK_SEC) * SR));
			if (!slice.length) break;
			await writeFile(piece, encodePcm16Wav(slice, SR));
			const result = await transcriber.transcribe({
				id: `${id}-${start}`,
				audioPath: piece,
				language: "en",
			});
			for (const word of result.words)
				words.push({ ...word, startSec: start + word.startSec, endSec: start + word.endSec });
			await rm(piece, { force: true });
		}
		return words;
	}
}

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SR } from "./acoustics";
import type { HesitationVetter } from "./types";
import { encodePcm16Wav } from "./wav";

export interface WordTranscriber {
	transcribe(request: {
		id: string;
		audioPath: string;
		language?: string;
	}): Promise<{ words: Array<{ word: string }> }>;
}

/** Re-reads a short window with the local Parakeet helper. */
export class ParakeetHesitationVetter implements HesitationVetter {
	private count = 0;

	constructor(
		private readonly transcriber: WordTranscriber,
		private readonly scratchDir: string,
	) {}

	async read(window: Float32Array): Promise<string[]> {
		if (!window.length) return [];
		await mkdir(this.scratchDir, { recursive: true });
		this.count += 1;
		const id = `vet-${this.count}`;
		const wavPath = path.join(this.scratchDir, `${id}.wav`);
		await writeFile(wavPath, encodePcm16Wav(window, SR));
		try {
			const result = await this.transcriber.transcribe({ id, audioPath: wavPath, language: "en" });
			return result.words.map((w) => w.word);
		} finally {
			await rm(wavPath, { force: true });
		}
	}
}

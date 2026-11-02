import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureModels, modelPaths } from "../stt/modelManager";

const LABELS = {
	model: "WAV2VEC2_ASR_BASE_960H",
	labels: [
		"-",
		"|",
		"E",
		"T",
		"A",
		"O",
		"N",
		"I",
		"H",
		"S",
		"R",
		"D",
		"L",
		"U",
		"M",
		"W",
		"C",
		"F",
		"G",
		"Y",
		"P",
		"B",
		"V",
		"K",
		"'",
		"X",
		"J",
		"Q",
		"Z",
	],
	blank: 0,
	separator: "|",
	sampleRate: 16000,
	minSamples: 1600,
	maxSamples: 480000,
	frameSamples: 320,
	receptiveFieldSamples: 400,
	input: "audio",
	output: "log_probs",
};

/**
 * Downloads the forced aligner on first use and writes the labels file the helper reads next to it.
 * Returns the model directory.
 */
export async function ensureAlignerModel(baseDir: string): Promise<string> {
	await ensureModels({ baseDir, only: ["wav2vec2-aligner"] });
	const dir = modelPaths(baseDir)["wav2vec2-aligner"];
	const labelsPath = path.join(dir, "labels.json");
	const labels = `${JSON.stringify(LABELS, null, 2)}\n`;
	if ((await readFile(labelsPath, "utf8").catch(() => null)) !== labels) {
		await mkdir(dir, { recursive: true });
		await writeFile(`${labelsPath}.partial`, labels);
		await rename(`${labelsPath}.partial`, labelsPath);
	}
	return dir;
}

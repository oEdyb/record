import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../stt/modelManager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../stt/modelManager")>()),
	ensureModels: vi.fn(async () => undefined),
}));

const { ensureAlignerModel } = await import("./alignerModel");
const { ensureModels } = await import("../stt/modelManager");

describe("ensureAlignerModel", () => {
	it("downloads the aligner and writes the labels the helper reads", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "aligner-"));
		const dir = await ensureAlignerModel(base);
		expect(ensureModels).toHaveBeenCalledWith({ baseDir: base, only: ["wav2vec2-aligner"] });
		expect(dir).toBe(path.join(base, "wav2vec2-base-960h-ctc-coreml"));
		const labels = JSON.parse(await readFile(path.join(dir, "labels.json"), "utf8"));
		expect(labels).toMatchObject({ blank: 0, separator: "|", input: "audio", output: "log_probs" });
		expect(labels.labels).toHaveLength(29);
	});

	it("rewrites stale labels", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "aligner-"));
		const dir = await ensureAlignerModel(base);
		await writeFile(path.join(dir, "labels.json"), "{}");
		await ensureAlignerModel(base);
		expect(JSON.parse(await readFile(path.join(dir, "labels.json"), "utf8")).output).toBe(
			"log_probs",
		);
	});
});

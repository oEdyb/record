import { describe, expect, it, vi } from "vitest";
import { editFixture, word } from "@/lib/ai-edition/checks/fixtures";
import { DEFAULT_EDGE_SILENCE_POLICY } from "@/lib/ai-edition/timeline/edge-silence";
import { analyzeProjectEdges } from "./analyzeProjectEdges";
import { loadPeaks, loadSpeechActivity } from "./analyzeProjectPauses";

vi.mock("./analyzeProjectPauses", () => ({ loadPeaks: vi.fn(), loadSpeechActivity: vi.fn() }));

function observations() {
	const probabilities = Float32Array.from({ length: 188 }, (_, i) =>
		i * 0.032 < 2 || i * 0.032 >= 4 ? 0.9 : 0.02,
	);
	const microphone = Float32Array.from({ length: 1200 }, (_, i) =>
		i < 200 || i >= 1000 ? 0.2 : 0.001,
	);
	vi.mocked(loadPeaks).mockResolvedValue(microphone);
	vi.mocked(loadSpeechActivity).mockResolvedValue({
		probabilities,
		cleanedProbabilities: null,
		frameSec: 0.032,
	});
}

describe("project edge safety evidence", () => {
	it("passes cleaned speech protection to internal-gap analysis", async () => {
		observations();
		vi.mocked(loadSpeechActivity).mockResolvedValue({
			probabilities: new Float32Array(188).fill(0.02),
			cleanedProbabilities: new Float32Array(188).fill(0.9),
			frameSec: 0.032,
		});
		const result = await analyzeProjectEdges(
			editFixture({ duration: 6 }),
			DEFAULT_EDGE_SILENCE_POLICY,
		);
		expect(result.suggestions).toEqual([]);
	});
	it.each([
		false,
		true,
	])("passes trusted words through the %s legacy transcript path", async (legacy) => {
		observations();
		const document = editFixture({
			duration: 6,
			words: [word("end.", 0, 1), word("next", 5, 6)].map((item) => ({
				...item,
				sourceRole: "you",
			})),
		});
		if (legacy) {
			document.transcript = document.transcripts[0];
			document.transcripts = [];
		}
		const result = await analyzeProjectEdges(document, DEFAULT_EDGE_SILENCE_POLICY);
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].sourceStartSec).toBeGreaterThan(1);
		expect(result.suggestions[0].sourceStartSec).toBeLessThan(1.5);
		expect(result.suggestions[0].sourceEndSec).toBeGreaterThan(4.5);
	});
});

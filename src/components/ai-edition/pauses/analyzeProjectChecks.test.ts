import { describe, expect, it, vi } from "vitest";
import { editFixture } from "@/lib/ai-edition/checks/fixtures";
import { analyzeProjectChecks } from "./analyzeProjectChecks";

const loaders = vi.hoisted(() => ({ loadPeaks: vi.fn(), loadSpeechActivity: vi.fn() }));
vi.mock("./analyzeProjectPauses", () => loaders);

describe("project checks media loading", () => {
	it("loads microphone peaks once per asset even for duplicated clips", async () => {
		loaders.loadPeaks.mockReset().mockResolvedValue(new Float32Array([-0.1, 0.1]));
		loaders.loadSpeechActivity.mockReset().mockResolvedValue(null);
		const document = editFixture();
		document.timeline.clips.push({
			...document.timeline.clips[0],
			id: "second",
			timelineStartSec: 20,
			timelineEndSec: 40,
		});
		await analyzeProjectChecks(document, {}, {});
		expect(loaders.loadPeaks).toHaveBeenCalledExactlyOnceWith("/take.mp4", 20, "microphone");
		expect(loaders.loadSpeechActivity).not.toHaveBeenCalled();
	});
	it("does not load media for camera-only rules", async () => {
		loaders.loadPeaks.mockClear();
		loaders.loadSpeechActivity.mockClear();
		await analyzeProjectChecks(editFixture(), { rule: "camera.nested" }, {});
		expect(loaders.loadPeaks).not.toHaveBeenCalled();
		expect(loaders.loadSpeechActivity).not.toHaveBeenCalled();
	});
	it("reports absent peaks when media loading fails", async () => {
		loaders.loadPeaks.mockRejectedValue(new Error("Unavailable"));
		const result = await analyzeProjectChecks(editFixture(), { rule: "gap.silence" }, {});
		expect(result.findings).toEqual([]);
		expect(result.notes.join()).toContain("peaks unavailable");
	});
});

describe("incremental checks", () => {
	it("publishes structural results first, bounds workers at two, and publishes each asset", async () => {
		const document = editFixture();
		for (let i = 1; i < 5; i++) {
			document.assets.push({
				...document.assets[0],
				id: `asset${i}`,
				originalPath: `/take${i}.mp4`,
			});
			document.timeline.clips.push({
				...document.timeline.clips[0],
				id: `clip${i}`,
				assetId: `asset${i}`,
				timelineStartSec: i * 20,
				timelineEndSec: (i + 1) * 20,
			});
		}
		const releases: (() => void)[] = [];
		let active = 0;
		let maximum = 0;
		loaders.loadPeaks.mockReset().mockImplementation(
			() =>
				new Promise((resolve) => {
					active++;
					maximum = Math.max(maximum, active);
					releases.push(() => {
						active--;
						resolve(new Float32Array([-0.1, 0.1]));
					});
				}),
		);
		loaders.loadSpeechActivity.mockClear();
		const progress = vi.fn();
		const running = analyzeProjectChecks(document, {}, { "/take.mp4": false }, progress);
		expect(progress.mock.calls[0][0]).toMatchObject({
			audio: { ready: 0, pending: 5 },
			result: { counts: { byRule: { "asset.missing": 1 } } },
		});
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		releases.shift()?.();
		await vi.waitFor(() =>
			expect(
				progress.mock.calls.some(([value]) => value.audio.ready === 1 && value.audio.pending === 4),
			).toBe(true),
		);
		const structural = await analyzeProjectChecks(
			document,
			{ rule: "asset.missing" },
			{ "/take.mp4": false },
		);
		expect(structural.total).toBe(1);
		for (let i = 0; i < 4; i++) {
			await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
			releases.shift()?.();
		}
		await running;
		expect(maximum).toBe(2);
		expect(progress.mock.lastCall?.[0].audio).toEqual({ ready: 5, pending: 0 });
		expect(loaders.loadSpeechActivity).not.toHaveBeenCalled();
	});
	it("loads speech only for explicit deep cut analysis", async () => {
		loaders.loadPeaks.mockReset().mockResolvedValue(null);
		loaders.loadSpeechActivity.mockReset().mockResolvedValue(null);
		await analyzeProjectChecks(editFixture(), { rule: "cut.mid-sentence", deep: true }, {});
		expect(loaders.loadSpeechActivity).toHaveBeenCalledExactlyOnceWith("/take.mp4");
	});
});

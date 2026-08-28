// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import {
	DEFAULT_PAUSE_POLICY,
	type PauseAnalysisPolicy,
} from "@/lib/ai-edition/timeline/pause-analysis";

const getRecordingData = vi.fn();

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		cursor: { getRecordingData: (...args: unknown[]) => getRecordingData(...args) },
	},
}));

import { analyzeProjectPauses } from "./analyzeProjectPauses";

function fixture() {
	const document = createEmptyDocument({ projectId: "project-1", title: "Pauses" });
	document.assets.push({
		id: "asset-1",
		kind: "video",
		label: "Recording",
		originalPath: "/recording.mp4",
		durationSec: 6,
		cameraTrack: null,
	});
	document.timeline.clips.push({
		id: "clip-1",
		assetId: "asset-1",
		sourceStartSec: 0,
		sourceEndSec: 6,
		timelineStartSec: 0,
		timelineEndSec: 6,
		wordRefs: [],
		origin: "user",
		reason: "",
	});
	document.transcripts.push({
		assetId: "asset-1",
		language: "en",
		segments: [],
		words: [
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hello" },
			{ id: "w2", segmentId: "s2", startSec: 5, endSec: 6, text: "again" },
		],
	});
	return document;
}

function quietPeaks(): Float32Array {
	const peaks = new Float32Array(6 * 50 * 2);
	for (let index = 0; index < peaks.length; index += 2) {
		peaks[index] = -0.001;
		peaks[index + 1] = 0.001;
	}
	return peaks;
}

beforeEach(() => {
	getRecordingData.mockReset();
	getRecordingData.mockResolvedValue(null);
});

describe("analyzeProjectPauses", () => {
	it("requests isolated tracks with the dense analysis profile", async () => {
		const getAudioPeaks = vi.fn(async (_path, _duration, track: string) => ({
			success: track !== "system",
			peaks: track === "system" ? null : quietPeaks(),
		}));
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: {
				getAudioPeaks,
				getSpeechActivity: vi.fn(async () => ({
					success: true,
					probabilities: new Float32Array([0.9, 0.02]),
					cleanedProbabilities: new Float32Array([0.95, 0.01]),
					frameSec: 0.032,
				})),
			},
		});

		await analyzeProjectPauses(fixture(), DEFAULT_PAUSE_POLICY);

		expect(getAudioPeaks).toHaveBeenCalledWith("/recording.mp4", 6, "microphone", "analysis");
		expect(getAudioPeaks).toHaveBeenCalledWith("/recording.mp4", 6, "system", "analysis");
	});

	it("uses mixed audio only when Audio level mode explicitly needs a fallback", async () => {
		const getAudioPeaks = vi.fn(async (_path, _duration, track: string) => ({
			success: track === "mixed",
			peaks: track === "mixed" ? quietPeaks() : null,
		}));
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { getAudioPeaks, getSpeechActivity: vi.fn() },
		});
		const policy: PauseAnalysisPolicy = {
			...DEFAULT_PAUSE_POLICY,
			mode: "audio-level",
			protectSystemAudio: false,
		};

		const result = await analyzeProjectPauses(fixture(), policy);

		expect(getAudioPeaks).toHaveBeenNthCalledWith(1, "/recording.mp4", 6, "microphone", "analysis");
		expect(getAudioPeaks).toHaveBeenNthCalledWith(2, "/recording.mp4", 6, "mixed", "analysis");
		expect(result.usedMixedAudio).toBe(true);
	});
});

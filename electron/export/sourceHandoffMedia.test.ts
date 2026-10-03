import { beforeEach, expect, it, vi } from "vitest";
import { resolveFfmpeg } from "../media/audioPeaks";
import { runRecordingFfmpeg } from "./recordingFastExport";
import { inspectHandoffSourceMedia, parseHandoffSourceMedia } from "./sourceHandoffMedia";

vi.mock("../media/audioPeaks", () => ({
	resolveFfmpeg: vi.fn(),
	audioTrackMapArgs: () => [],
}));
vi.mock("./recordingFastExport", () => ({ runRecordingFfmpeg: vi.fn() }));

function header(format: string, duration: string, start: string) {
	return `Input #0, ${format}, from 'source':
  Duration: ${duration}, start: ${start}, bitrate: 100 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 160x90, 30 fps
  Stream #0:1(qac): Audio: aac (LC), 48000 Hz, stereo
`;
}

it.each([
	["matroska,webm", "00:00:06.00", "5.000000", 1],
	["matroska,webm", "00:00:06.20", "5.200000", 1],
	["matroska,webm", "00:00:01.00", "0.000000", 1],
	["matroska,webm", "00:00:01.00", "-0.007000", 1],
	["mov,mp4,m4a,3gp,3g2,mj2", "00:00:01.00", "5.000000", 1],
	["mov,mp4,m4a,3gp,3g2,mj2", "00:00:01.00", "-0.023220", 1],
] as const)("normalizes %s duration %s at origin %s to %ss without changing track identity", (format, duration, start, expected) => {
	expect(parseHandoffSourceMedia(header(format, duration, start))).toMatchObject({
		durationSec: expected,
		hasAudio: true,
		hasKlipptMetadata: true,
		roles: ["you"],
		video: { codec: "h264", width: 160, height: 90, fps: 30 },
	});
});

it.each([
	header("matroska,webm", "00:00:05.00", "5.000000"),
	header("matroska,webm", "00:00:01.00", "5.000000"),
	header("matroska,webm", "N/A", "5.000000"),
	header("matroska,webm", "00:00:06.00", "N/A"),
])("declines an unknown or nonpositive normalized duration", (stderr) => {
	expect(parseHandoffSourceMedia(stderr).durationSec).toBeNull();
});

beforeEach(() => {
	vi.mocked(resolveFfmpeg).mockReset().mockReturnValue("bundled-ffmpeg");
	vi.mocked(runRecordingFfmpeg)
		.mockReset()
		.mockResolvedValue(header("matroska,webm", "00:00:06.00", "5.000000"));
});

it("inspects headers once with copy-to-null and returns normalized available time", async () => {
	expect((await inspectHandoffSourceMedia("offset.mkv")).durationSec).toBe(1);
	expect(runRecordingFfmpeg).toHaveBeenCalledExactlyOnceWith(
		"bundled-ffmpeg",
		[
			"-i",
			"offset.mkv",
			"-map",
			"0:v?",
			"-map",
			"0:a?",
			"-t",
			"0",
			"-c",
			"copy",
			"-f",
			"null",
			"-",
		],
		expect.any(AbortSignal),
		10_000,
	);
});

it("reports a missing binary before inspecting or copying media", async () => {
	vi.mocked(resolveFfmpeg).mockReturnValue(null);
	await expect(inspectHandoffSourceMedia("source.mp4")).rejects.toThrow("unavailable");
	expect(runRecordingFfmpeg).not.toHaveBeenCalled();
});

import { describe, expect, it } from "vitest";
import {
	calculateEffectiveExportDuration,
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	calculateMp4ExportSettingsForResolution,
	estimateMp4FileSizeBytes,
	formatBitrate,
	formatExportEta,
	wouldUpscale,
} from "./mp4ExportSettings";

describe("calculateMp4ExportSettings", () => {
	it("uses an exact custom canvas while keeping encoder-safe dimensions", () => {
		expect(
			calculateMp4ExportSettingsForResolution({
				quality: "source",
				width: 1081,
				height: 1921,
			}),
		).toEqual({ width: 1080, height: 1920, bitrate: 10_000_000 });
	});

	it("keeps 2K explicit even when it upscales short native captures", () => {
		const aspectRatioValue = 1920 / 1032;

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
			}),
		).toMatchObject({
			width: 2678,
			height: 1440,
			bitrate: 17_100_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
			}),
		).toMatchObject({
			width: 1920,
			height: 1032,
			bitrate: 9_700_000,
		});
	});

	it("maps Medium to 1080p when the project is 16:9", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "medium",
				sourceWidth: 3840,
				sourceHeight: 2160,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 8_000_000,
		});
	});

	it("maps High to 2K even for smaller source dimensions", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1280,
				sourceHeight: 720,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 2560,
			height: 1440,
			bitrate: 16_000_000,
		});
	});

	it("preserves source dimensions for Highest", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 10_000_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 3840,
				sourceHeight: 2160,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 3840,
			height: 2160,
			bitrate: 56_300_000,
		});
	});

	it("pads Highest to 16:9 without shrinking Retina source pixels", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1710,
				sourceHeight: 1106,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({ width: 1968, height: 1106 });

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 3420,
				sourceHeight: 2214,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({ width: 3936, height: 2214, bitrate: 58_700_000 });
	});

	it("keeps portrait presets on the short side", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1080,
				sourceHeight: 1920,
				aspectRatioValue: 9 / 16,
			}),
		).toMatchObject({
			width: 1440,
			height: 2560,
			bitrate: 16_000_000,
		});
	});

	it("does not call letterbox rows an upscale (1920x1032 window capture, 16:9 project)", () => {
		const source = { width: 1920, height: 1032 };
		const tier = (quality: "medium" | "good" | "source") =>
			calculateMp4ExportSettings({
				quality,
				sourceWidth: source.width,
				sourceHeight: source.height,
				aspectRatioValue: 16 / 9,
			});

		// Medium and Highest resolve to the same 1920x1080 canvas here. The extra rows are
		// letterbox content, so neither tier stretches the source pixels.
		expect(tier("medium")).toMatchObject({ width: 1920, height: 1080 });
		expect(tier("medium")).toMatchObject({ bitrate: 8_000_000 });
		expect(tier("source")).toMatchObject({ width: 1920, height: 1080 });
		expect(wouldUpscale(tier("source"), source)).toBe(false);
		expect(wouldUpscale(tier("medium"), source)).toBe(false);
		expect(wouldUpscale(tier("good"), source)).toBe(true);
	});

	it("still flags a tier that genuinely stretches the source", () => {
		const source = { width: 1280, height: 720 };
		expect(
			wouldUpscale(
				calculateMp4ExportSettings({
					quality: "good",
					sourceWidth: source.width,
					sourceHeight: source.height,
					aspectRatioValue: 16 / 9,
				}),
				source,
			),
		).toBe(true);
	});

	it("uses the cropped area as the effective source size", () => {
		const effectiveSource = calculateEffectiveSourceDimensions(3840, 2160, {
			width: 854 / 3840,
			height: 480 / 2160,
		});

		expect(effectiveSource).toEqual({
			width: 854,
			height: 480,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
			}),
		).toMatchObject({
			width: 854,
			height: 480,
			bitrate: 3_100_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
			}),
		).toMatchObject({
			width: 2562,
			height: 1440,
			bitrate: 16_000_000,
		});
	});
});

describe("MP4 export estimates", () => {
	it("uses frame rate and codec to model the target bitrate", () => {
		const settings = (fps: number, codec: "h264" | "h265") =>
			calculateMp4ExportSettings({
				quality: "medium",
				sourceWidth: 3840,
				sourceHeight: 2160,
				aspectRatioValue: 16 / 9,
				fps,
				codec,
			});

		expect(settings(24, "h264").bitrate).toBe(8_000_000);
		expect(settings(30, "h264").bitrate).toBe(8_000_000);
		expect(settings(45, "h264").bitrate).toBe(10_000_000);
		expect(settings(60, "h264").bitrate).toBe(12_000_000);
		expect(settings(24, "h265").bitrate).toBe(4_800_000);
	});

	it("gives Highest extra bitrate when its source canvas matches Medium", () => {
		const common = {
			sourceWidth: 1920,
			sourceHeight: 1080,
			aspectRatioValue: 16 / 9,
			fps: 30,
			codec: "h264" as const,
		};

		expect(calculateMp4ExportSettings({ ...common, quality: "medium" }).bitrate).toBe(8_000_000);
		expect(calculateMp4ExportSettings({ ...common, quality: "source" }).bitrate).toBe(10_000_000);
	});

	it("estimates the encoded duration after clip-specific speed regions", () => {
		expect(
			calculateEffectiveExportDuration(
				[
					{ sourceStartSec: 0, sourceEndSec: 10 },
					{ sourceStartSec: 5, sourceEndSec: 15 },
				],
				[
					{ clipIndex: 0, startSec: 2, endSec: 6, speed: 2 },
					{ clipIndex: 1, startSec: 5, endSec: 15, speed: 2 },
				],
			),
		).toBe(13);
	});

	it("includes the native AAC stream and MP4 overhead in the size estimate", () => {
		expect(
			estimateMp4FileSizeBytes({
				durationSec: 60,
				videoBitrate: 20_000_000,
				hasAudio: true,
			}),
		).toBe(155_937_600);
	});

	it("formats preset bitrates for the export summary", () => {
		expect(formatBitrate(20_000_000)).toBe("20 Mbps");
		expect(formatBitrate(2_500_000)).toBe("2.5 Mbps");
	});

	it("formats the remaining export time as a clock", () => {
		expect(formatExportEta(272)).toBe("4:32");
		expect(formatExportEta(3_902)).toBe("1:05:02");
		expect(formatExportEta(Number.NaN)).toBe("0:00");
	});
});

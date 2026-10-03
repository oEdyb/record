import { afterEach, describe, expect, it } from "vitest";
import {
	applyWebcamFormat,
	clearWebcamFormatProbeCache,
	DEFAULT_WEBCAM_FORMAT,
	formatWebcamFormat,
	normalizeWebcamFormat,
	probeWebcamFormats,
	probeWebcamFormatsCached,
	WEBCAM_FORMAT_CANDIDATES,
} from "./webcamFormats";

afterEach(() => {
	clearWebcamFormatProbeCache();
});

describe("webcam formats", () => {
	it("uses a practical 1080p/30 default and readable labels", () => {
		expect(DEFAULT_WEBCAM_FORMAT).toEqual({ width: 1920, height: 1080, fps: 30 });
		expect(formatWebcamFormat({ width: 3840, height: 2160, fps: 30 })).toBe("4K, 30 FPS");
		expect(formatWebcamFormat({ width: 2560, height: 1440, fps: 30 })).toBe("2K, 30 FPS");
		expect(formatWebcamFormat({ width: 1920, height: 1080, fps: 60 })).toBe("1080p, 60 FPS");
	});

	it("normalizes persisted values without accepting unsafe dimensions", () => {
		expect(normalizeWebcamFormat({ width: 3840, height: 2160, fps: 30 })).toEqual({
			width: 3840,
			height: 2160,
			fps: 30,
		});
		expect(normalizeWebcamFormat({ width: 100_000, height: 2160, fps: 30 })).toEqual(
			DEFAULT_WEBCAM_FORMAT,
		);
	});

	it("applies one resolution and frame-rate combination as required constraints", async () => {
		const applied: MediaTrackConstraints[] = [];
		const track = {
			applyConstraints: async (constraints: MediaTrackConstraints) => {
				applied.push(constraints);
			},
		};

		await applyWebcamFormat(track, { width: 1920, height: 1080, fps: 60 }, "exact");

		expect(applied).toEqual([
			{
				width: { exact: 1920 },
				height: { exact: 1080 },
				frameRate: { min: 59, ideal: 60, max: 60 },
			},
		]);
	});

	it("probes combinations instead of combining unrelated capability maxima", async () => {
		let current = { width: 1280, height: 720, frameRate: 30 };
		const originalConstraints = { width: { ideal: 1280 } } satisfies MediaTrackConstraints;
		const track = {
			getCapabilities: () => ({
				width: { min: 640, max: 3840 },
				height: { min: 480, max: 2160 },
				frameRate: { min: 15, max: 59.94 },
			}),
			getConstraints: () => originalConstraints,
			getSettings: () => current,
			applyConstraints: async (constraints: MediaTrackConstraints) => {
				if (constraints === originalConstraints) return;
				const width = (constraints.width as { exact?: number } | undefined)?.exact;
				const height = (constraints.height as { exact?: number } | undefined)?.exact;
				const fps = (constraints.frameRate as { ideal?: number } | undefined)?.ideal;
				if (width === 3840 && fps === 60)
					throw new DOMException("unsupported", "OverconstrainedError");
				if (width === 3840 && fps === 30) {
					current = { width, height: height ?? 2160, frameRate: fps };
					return;
				}
				if (width === 1920 && fps === 60) {
					current = { width, height: height ?? 1080, frameRate: fps };
					return;
				}
				throw new DOMException("unsupported", "OverconstrainedError");
			},
		};

		const candidates = [{ width: 3840, height: 2160, fps: 60 }, ...WEBCAM_FORMAT_CANDIDATES];
		const supported = await probeWebcamFormats(track, candidates);

		expect(supported).toEqual([
			{ width: 3840, height: 2160, fps: 30 },
			{ width: 1920, height: 1080, fps: 60 },
		]);
	});

	it("probes each camera once per session and reuses the result for the same device", async () => {
		const probes: string[] = [];
		const makeTrack = (deviceId: string) => ({
			label: `Camera ${deviceId}`,
			getCapabilities: () => ({
				width: { min: 640, max: 1920 },
				height: { min: 480, max: 1080 },
				frameRate: { min: 15, max: 30 },
			}),
			getConstraints: () => ({}),
			getSettings: () => ({ deviceId, width: 1920, height: 1080, frameRate: 30 }),
			applyConstraints: async (constraints: MediaTrackConstraints) => {
				const width = (constraints.width as { exact?: number } | undefined)?.exact;
				if (width !== undefined) probes.push(`${deviceId}:${width}`);
			},
		});

		const first = await probeWebcamFormatsCached(makeTrack("cam-a"));
		const again = await probeWebcamFormatsCached(makeTrack("cam-a"));
		await probeWebcamFormatsCached(makeTrack("cam-b"));

		expect(first).toEqual([{ width: 1920, height: 1080, fps: 30 }]);
		expect(again).toEqual(first);
		expect(again).not.toBe(first);
		expect(probes).toEqual(["cam-a:1920", "cam-a:1280", "cam-b:1920", "cam-b:1280"]);
	});
});

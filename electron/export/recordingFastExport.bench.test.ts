import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CompositorViewAddon } from "../native/compositor-view/addon";
import { prepareRecordingFastExport } from "./recordingFastExport";

// Real-media copy benchmark. Run on a Mac with copies of recordings, never library originals:
// KLIPPT_COPY_BENCH='{"takes":["/copy/clip-0001.mp4"],"out":"/scratch/out.mp4","width":3420,"height":2214}'
//   npx vitest --run electron/export/recordingFastExport.bench.test.ts
const spec = process.env.KLIPPT_COPY_BENCH;

describe.runIf(process.platform === "darwin" && spec)("recording copy benchmark", () => {
	it("copies the takes into one video", { timeout: 6 * 60 * 60_000 }, async () => {
		const { takes, out, width, height } = JSON.parse(spec!) as {
			takes: string[];
			out: string;
			width: number;
			height: number;
		};
		const addon = createRequire(import.meta.url)(
			path.resolve("electron/native/bin/darwin-arm64/compositor_view.node"),
		) as CompositorViewAddon;
		const durations = await Promise.all(takes.map((take) => addon.probeMediaDuration!(take)));
		const clips = takes.map((take, index) => ({
			screenPath: take,
			webcamPath: "",
			sourceStartSec: 0,
			sourceEndSec: durations[index]!,
			webcamOffsetSec: 0,
			hasAudio: true,
		}));
		const scene = {
			clips,
			layout: {
				preset: "no-webcam",
				webcamSize: 0.25,
				webcamZoom: 1,
				webcamFocalPoint: { cx: 0.5, cy: 0.5 },
				screenZoom: 1,
				screenFocalPoint: { cx: 0.5, cy: 0.5 },
				webcamShape: "rectangle",
				webcamMirror: false,
				webcamPosition: null,
				webcamReactiveZoom: false,
				webcamRect: null,
				screenRect: { x: 0, y: 0, width: 1, height: 1 },
				screenCover: false,
			},
			effects: { padding: 0, blur: false, shadow: 0, roundnessFrac: 0, motionBlur: 0 },
			background: { kind: "color", color: "#000000" },
			zoomRegions: [],
			annotations: [],
			cameraFullscreenRegions: [],
			speedRegions: [],
			cursor: {
				show: true,
				size: 1,
				smoothing: 0,
				motionBlur: 0,
				clickBounce: 0,
				clipToBounds: false,
				theme: "default",
			},
			cropByClip: clips.map(() => null),
			output: { width, height, fps: 60 },
		};
		const signal = new AbortController().signal;
		const started = performance.now();
		const plan = await prepareRecordingFastExport({
			clips,
			sceneJson: JSON.stringify(scene),
			sourceDurationsSec: durations,
			params: {
				width,
				height,
				fps: 60,
				codec: "h264",
				preserveRecordingSource: true,
				normalizeAudio: false,
				evenVolume: false,
			},
			signal,
			onProgress: () => undefined,
		});
		expect(plan).not.toBeNull();
		const prepared = performance.now();
		const result = await plan!.render(out, signal, () => undefined);
		const wallSec = (performance.now() - started) / 1000;
		const videoSec = durations.reduce((sum, value) => sum + value, 0);
		// The suite silences console output, so the result goes next to the output file.
		appendFileSync(
			`${out}.bench.log`,
			`BENCH copy: takes=${takes.length} video_s=${videoSec.toFixed(1)} prepare_s=${((prepared - started) / 1000).toFixed(2)} wall_s=${wallSec.toFixed(2)} realtime=${(videoSec / wallSec).toFixed(1)}x frames=${result.frames} decoder=${result.decoderPath} encoder=${result.encoderName} hardware=${result.encoderHardware}\n`,
		);
	});
});

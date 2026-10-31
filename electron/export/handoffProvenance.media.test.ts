import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveFfmpeg } from "../media/audioPeaks";
import { inspectFileFacts } from "./handoffProvenance";

it("probes actual constant and variable packet cadence", async () => {
	const ffmpeg = resolveFfmpeg();
	expect(ffmpeg).not.toBeNull();
	if (!ffmpeg) throw new Error("Missing FFmpeg test dependency.");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-probe-"));
	try {
		for (const variable of [false, true]) {
			const file = path.join(root, variable ? "variable.mp4" : "constant.mp4");
			execFileSync(ffmpeg, [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=s=160x90:r=60:d=1",
				...(variable ? ["-vf", "select='not(eq(mod(n,3),0))'", "-fps_mode", "vfr"] : []),
				"-c:v",
				"mpeg4",
				file,
			]);
			const facts = await inspectFileFacts(file);
			expect(facts[0]).toMatchObject({
				codec: "mpeg4",
				type: "video",
				variableFrameRate: variable,
				variableFrameRateMethod: "packet-presentation-intervals",
				timebase: expect.any(String),
				durationSec: expect.any(Number),
			});
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

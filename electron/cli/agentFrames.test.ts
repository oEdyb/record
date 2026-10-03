// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import { expandVideoOverlayFade } from "../../src/native/sceneDescription";
import { editedFrameTime, renderAgentFrames } from "./agentFrames";
import { prepareAgentPreview } from "./agentPreview";
import { agentSkill } from "./agentSkill";
import { resolveExportSeconds, type TimeInput } from "./agentTimeBase";

describe("frame clocks and overlay motion", () => {
	it("maps edited frames across trims without adding removed time", () => {
		const document = editFixture({ trims: [[2, 5]] });
		expect(editedFrameTime(document, 6)).toBe(6);
		expect(() => editedFrameTime(document, 17)).toThrow("OUTSIDE");
	});
	it("maps the edited clock into speed-adjusted export frames", () => {
		const document = editFixture();
		document.assets[0].video = { codec: "h264", width: 1920, height: 1080, fps: 60 };
		document.legacyEditor = { speedRegions: [{ id: "speed", startMs: 0, endMs: 10000, speed: 2 }] };
		const editorTime = 6;
		const outputTime = editedFrameTime(document, editorTime);
		expect(outputTime).toBe(3);
		expect(prepareAgentPreview(document, outputTime).frameTime).toBe(outputTime);
		expect(prepareAgentPreview(document, editorTime).frameTime).not.toBe(outputTime);
		expect(agentSkill().content).toContain(
			`With the first 10 s at 2× speed, \`frame --at ${editorTime}\` corresponds to \`preview --time ${outputTime}\`.`,
		);
		expect(agentSkill().content).toMatch(
			/`preview --time`\s*\|\s*Speed-adjusted export\/output seconds/,
		);
	});
	it("converts suffixed preview --time input into the export clock", () => {
		const document = editFixture();
		document.assets[0].video = { codec: "h264", width: 1920, height: 1080, fps: 60 };
		document.legacyEditor = { speedRegions: [{ id: "speed", startMs: 0, endMs: 10000, speed: 2 }] };
		expect(resolveExportSeconds(document, { seconds: 6, base: "edited" })).toBe(3);
		expect(resolveExportSeconds(document, { seconds: 6, base: "raw" })).toBe(3);
		// Bare numbers stay speed-adjusted output seconds (compatibility).
		expect(resolveExportSeconds(document, { seconds: 3, base: "output" })).toBe(3);
	});
	it("resolves suffixed frame --at input through the editor clock", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-frames-"));
		try {
			const project = path.join(dir, "p.klippt");
			await writeFile(project, JSON.stringify(editFixture({ trims: [[2, 5]] })));
			const render = vi.fn(async (options: { time: number | TimeInput }) => ({
				kind: "composed_frame",
				snapshot: "snapshot",
				source_project: project,
				frame_path: path.join(dir, "frame.png"),
				manifest_path: path.join(dir, "manifest.json"),
				requested_edited_time_sec:
					typeof options.time === "number" ? options.time : options.time.seconds,
				frame_time_sec: 0,
				fps: 60,
				output: { width: 1280, height: 720 },
				project_edited_duration_sec: 17,
				time_bases: {
					requested_edited_time_sec: "export_output_seconds",
					frame_time_sec: "export_output_seconds",
					project_edited_duration_sec: "export_output_seconds",
				},
				sha256: "hash",
				renderer: "mock",
				limitations: [],
			}));
			const result = await renderAgentFrames(
				{
					projectPath: project,
					// raw 9 and edited 6 are the same instant across the 2–5 s trim.
					at: [{ seconds: 9, base: "raw" }, 6],
					cacheDirectory: dir,
					launch: { executable: "electron", args: [] },
					sheet: false,
				},
				render,
			);
			expect(render.mock.calls.map((call) => call[0].time)).toEqual([6, 6]);
			expect(result.frames.map((frame) => frame.at)).toEqual([6, 6]);
			expect(result.time_bases).toMatchObject({
				at: expect.stringContaining("edited"),
				exportTimeSec: expect.stringContaining("export"),
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("expands fade into native opacity intervals without restarting media at cuts", () => {
		const region = {
			id: "v",
			startSec: 5,
			endSec: 7,
			path: "/v.mp4",
			sourceOffsetSec: 1,
			fit: "cover" as const,
			rect: null,
			opacity: 1,
			clipIndex: 0,
		};
		const frames = expandVideoOverlayFade(region, 4.9);
		expect(frames[0].opacity).toBeCloseTo(1 / 3);
		expect(frames.at(-1)).toMatchObject({ opacity: 1, endSec: 7 });
		expect(frames.at(-1)!.sourceOffsetSec).toBeCloseTo(1.2);
		for (let i = 1; i < frames.length; i++) expect(frames[i].startSec).toBe(frames[i - 1].endSec);
	});
});

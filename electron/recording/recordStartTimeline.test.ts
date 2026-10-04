import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecordStartTiming, RecordStartTimeline } from "./recordStartTimeline";

describe("RecordStartTimeline", () => {
	it("measures each step from the click, renderer and main together", () => {
		let clock = 1_150;
		const timeline = new RecordStartTimeline(
			() => clock,
			[
				{ stage: "click", atMs: 1_000 },
				{ stage: "start-requested", atMs: 1_100 },
			],
		);
		timeline.mark("ipc-received");
		clock = 1_900;
		timeline.mark("helper:recording-started");

		expect(timeline.steps()).toEqual([
			{ stage: "click", sinceClickMs: 0, stepMs: 0 },
			{ stage: "start-requested", sinceClickMs: 100, stepMs: 100 },
			{ stage: "ipc-received", sinceClickMs: 150, stepMs: 50 },
			{ stage: "helper:recording-started", sinceClickMs: 900, stepMs: 750 },
		]);
	});

	it("ignores malformed renderer marks", () => {
		const timeline = new RecordStartTimeline(
			() => 0,
			[
				{ stage: "click", atMs: Number.NaN },
				{ stage: "ok", atMs: 5 },
			],
		);
		expect(timeline.steps().map((step) => step.stage)).toEqual(["ok"]);
	});

	it("keeps only the newest starts in the log", async () => {
		const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "start-timing-")), "log.jsonl");
		for (let index = 0; index < 55; index += 1) {
			await appendRecordStartTiming(file, { recordedAt: String(index), success: true, steps: [] });
		}
		const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(50);
		expect(JSON.parse(lines[49]).recordedAt).toBe("54");
	});
});

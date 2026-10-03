// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PAUSE_POLICY,
	PAUSE_PRESETS,
} from "../../src/lib/ai-edition/timeline/pause-analysis";
import { buildPausePolicy, formatPauseReport, pausesCommandInput } from "./agentPauses";

const suggestion = (n: number) => ({
	id: `s${n}`,
	kind: "pause" as const,
	clipId: "c",
	assetId: "a",
	silenceStartSec: n,
	silenceEndSec: n + 1,
	sourceStartSec: n + 0.12,
	sourceEndSec: n + 0.82,
	timelineStartSec: n + 0.12,
	timelineEndSec: n + 0.82,
	savedSec: 0.7,
});

describe("agent pauses", () => {
	it("builds the editor policy from a preset plus explicit overrides only", () => {
		const base = buildPausePolicy(pausesCommandInput.parse({ project_id: "p" }));
		expect(base).toEqual({ ...DEFAULT_PAUSE_POLICY, ...PAUSE_PRESETS.balanced });
		const tuned = buildPausePolicy(
			pausesCommandInput.parse({
				project_id: "p",
				preset: "tight",
				min_pause: 0.4,
				protect_screen_activity: "false",
				ignore_non_speech: "true",
				mode: "audio-level",
			}),
		);
		expect(tuned).toMatchObject({
			minimumPauseSec: 0.4,
			shortenedPauseSec: PAUSE_PRESETS.tight.shortenedPauseSec,
			protectScreenActivity: false,
			includeNonSpeechEvents: true,
			protectSystemAudio: true,
			mode: "audio-level",
		});
	});

	it("pages suggestions and emits matching addTrim operations", () => {
		const report = {
			status: "ready" as const,
			revision: "r",
			policy: DEFAULT_PAUSE_POLICY,
			analyzedClipCount: 1,
			missingTranscript: false,
			missingMicrophone: false,
			missingSpeechActivity: false,
			usedMixedAudio: false,
			suggestions: [suggestion(1), suggestion(2), suggestion(3)],
			error: null,
		};
		const page = formatPauseReport(report, 1, 1);
		expect(page.totals).toEqual({ suggestions: 3, saved_seconds: 2.1 });
		expect(page.suggestions).toEqual([
			{
				id: "s2",
				kind: "pause",
				clip_id: "c",
				source_start: 2.12,
				source_end: 2.82,
				timeline_start: 2.12,
				timeline_end: 2.82,
				saved_seconds: 0.7,
			},
		]);
		expect(page.operations).toEqual([
			{
				type: "addTrim",
				args: { clipId: "c", startSec: 2.12, endSec: 2.82, reason: "Shortened pause" },
			},
		]);
		expect(page.next_offset).toBe(2);
		const filtered = formatPauseReport(
			{ ...report, suggestions: [suggestion(1), { ...suggestion(2), clipId: "other" }] },
			0,
			10,
			"other, missing",
		);
		expect(filtered.totals.suggestions).toBe(1);
		expect(filtered.operations[0].args.clipId).toBe("other");
		expect(
			formatPauseReport({ ...report, status: "analyzing" }, 0, 10).next_actions[0].command,
		).toMatch(/Repeat/);
	});

	it("accepts an --accept reason with an optional request id, and rejects a blank reason", () => {
		expect(
			pausesCommandInput.parse({
				project_id: "p",
				accept: " reviewed in staged ",
				request_id: "r1",
			}),
		).toMatchObject({ accept: "reviewed in staged", request_id: "r1" });
		expect(pausesCommandInput.parse({ project_id: "p" }).accept).toBeUndefined();
		expect(() => pausesCommandInput.parse({ project_id: "p", accept: "   " })).toThrow();
	});
});

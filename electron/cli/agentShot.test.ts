// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editFixture, word } from "../../src/lib/ai-edition/checks/fixtures";
import type { renderAgentFrames } from "./agentFrames";
import { runAgentShot, shotCommandInput } from "./agentShot";
import type { ProposalFlowReply } from "./agentWriteFlow";

type RenderFrame = typeof renderAgentFrames;

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Call {
	command: string;
	input: Record<string, unknown>;
}

async function setup(overrides: Record<string, ProposalFlowReply> = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), "agent-shot-"));
	dirs.push(directory);
	const projects = path.join(directory, "projects");
	await mkdir(projects, { recursive: true });
	const document = editFixture({
		duration: 100,
		trims: [[40, 42]],
		words: [
			word("hello", 9, 9.4),
			word("world.", 9.5, 10),
			word("round", 30, 30.4),
			word("one", 30.5, 30.9),
			word("restrictions", 31, 31.6),
		],
	});
	await writeFile(path.join(projects, "project.klippt"), JSON.stringify(document));
	const calls: Call[] = [];
	const defaults: Record<string, ProposalFlowReply> = {
		inspect: {
			status: "completed",
			data: {
				id: "project",
				title: "Fixture",
				dirty: true,
				currentTimeSec: 3,
				busy: false,
				syncPending: false,
			},
		},
		state: {
			status: "completed",
			data: {
				projectId: "project",
				revision: "rev-7",
				documentHash: "hash-1",
				state: {
					clip: { value: { id: "clip", name: "Take one" }, layer: "project" },
					cuts: { previous: { at: 8, distanceSec: 2 }, next: { at: 12, distanceSec: 2 } },
					layout: { cameraSize: { value: "M", percent: 30 }, cameraAnchor: { value: "right" } },
					regions: [],
				},
				spans: [],
			},
		},
		staged: {
			status: "completed",
			data: {
				lane_count: 2,
				rejected_earlier: 0,
				offset: 0,
				next_offset: null,
				cuts: [
					{
						id: "cut-near",
						clipId: "clip",
						kind: "agent",
						origin: "agent plan x",
						selected: true,
						sourceStartSec: 40,
						sourceEndSec: 42,
						editedStartSec: 8,
						editedEndSec: 9,
					},
					{
						id: "cut-far",
						clipId: "clip",
						kind: "pause",
						origin: "Shorten Pauses",
						selected: true,
						sourceStartSec: 60,
						sourceEndSec: 61,
						editedStartSec: 58,
						editedEndSec: 59,
					},
				],
			},
		},
	};
	const request = vi.fn(async (command: string, input: Record<string, unknown>) => {
		calls.push({ command, input });
		const reply = { ...defaults, ...overrides }[command];
		if (!reply) throw new Error(`Unexpected command ${command}`);
		return reply;
	});
	const renderFrame = vi.fn(async () => ({
		snapshot: "hash-1",
		frames: [{ at: 10, exportTimeSec: 10, path: "/cache/frame.png", elapsedMs: 5, manifest: "m" }],
		time_bases: { at: "edited", exportTimeSec: "output" },
	}));
	return { projects, calls, request, renderFrame };
}

const parse = (input: Record<string, unknown>) => shotCommandInput.parse(input);

describe("agent shot", () => {
	it("composes identity, bases, layers, cuts, staged range, transcript and a saved render", async () => {
		const s = await setup();
		const result = (await runAgentShot(parse({ project_id: "project", at: 10 }), {
			request: s.request,
			projectsDirectory: s.projects,
			previewLaunch: { executable: "/bin/false", args: [] },
			renderFrame: s.renderFrame as unknown as RenderFrame,
		})) as { status: string; data: Record<string, never> };
		expect(result.status).toBe("completed");
		const data = result.data;
		expect(data.project).toMatchObject({
			id: "project",
			revision: "rev-7",
			dirty: true,
			document_hash: "hash-1",
		});
		expect(data.instant).toMatchObject({
			edited_sec: 10,
			raw_sec: 10,
			source_sec: 10,
			clip_id: "clip",
			input_base: "edited",
		});
		expect(data.layers).toMatchObject({
			clip: { value: { id: "clip" } },
			layout: { cameraSize: { value: "M" } },
		});
		expect(data.cuts).toMatchObject({ previous: { at: 8 }, next: { at: 12 } });
		expect(data.staged).toMatchObject({ lane_count: 2, truncated: false });
		expect((data.staged as { in_range: { id: string }[] }).in_range.map((cut) => cut.id)).toEqual([
			"cut-near",
		]);
		expect(data.transcript).toMatchObject({
			source: "saved_project",
			status: "stored",
			sentence: { text: "hello world." },
		});
		expect(data.image).toMatchObject({
			source: "saved_render",
			status: "ok",
			path: "/cache/frame.png",
		});
		expect(data.evidence).toEqual({
			state: "live_editor",
			transcript: "saved_project",
			image: "saved_render",
		});
		// The state request used the locally resolved edited seconds.
		expect(s.calls.map((call) => call.command)).toEqual(["inspect", "state", "staged"]);
		expect(s.calls[1].input).toEqual({ projectId: "project", at: 10 });
		expect(s.renderFrame).toHaveBeenCalledOnce();
	});

	it("--live seeks the editor and writes the grabbed canvas frame", async () => {
		const frame = `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`;
		let transportCalls = 0;
		const s = await setup({
			transport: { status: "completed", data: {} },
		});
		s.request.mockImplementation(async (command: string, input: Record<string, unknown>) => {
			s.calls.push({ command, input });
			if (command === "transport") {
				transportCalls++;
				if (transportCalls === 1) return { status: "completed", data: { status: "running" } };
				return {
					status: "completed",
					data: {
						status: "ready",
						result: {
							samples: [
								{ label: "shot", frame, currentTimeSec: 10, videoTimeSec: 10, frameSettled: true },
							],
						},
						resolved_seeks: [{ edited_sec: 10, raw_sec: 10, source_sec: 10 }],
					},
				};
			}
			const reply = (
				{
					inspect: { status: "completed", data: { id: "project", dirty: false } },
					state: {
						status: "completed",
						data: { revision: "r", state: { clip: null, cuts: null, layout: {}, regions: [] } },
					},
					staged: { status: "completed", data: { lane_count: 0, cuts: [], next_offset: null } },
				} as Record<string, ProposalFlowReply>
			)[command];
			if (!reply) throw new Error(`Unexpected command ${command}`);
			return reply;
		});
		const result = (await runAgentShot(parse({ project_id: "project", at: "10e", live: true }), {
			request: s.request,
			projectsDirectory: s.projects,
			pollIntervalMs: 1,
			renderFrame: s.renderFrame as unknown as RenderFrame,
		})) as { status: string; data: Record<string, never> };
		expect(result.status).toBe("completed");
		const image = result.data.image as {
			source: string;
			status: string;
			path: string;
			frame_settled: boolean;
			freshness: string;
			captured: { current_time_sec: number };
		};
		expect(image).toMatchObject({
			source: "live_preview",
			status: "ok",
			frame_settled: true,
			freshness: "settled",
			captured: { current_time_sec: 10 },
		});
		expect(image).not.toHaveProperty("freshness_note");
		expect([...(await readFile(image.path))]).toEqual([1, 2, 3]);
		expect(s.renderFrame).not.toHaveBeenCalled();
		const transport = s.calls.find((call) => call.command === "transport");
		// No blind settle wait: the frame sample awaits the settle handshake
		// itself and reports frameSettled.
		expect(transport?.input.steps).toEqual([
			{ op: "seek", sec: 10 },
			{ op: "sample", label: "shot", frame: true },
		]);
	});

	it.each([
		{
			name: "the settle wait expired (frameSettled: false)",
			sample: { frameSettled: false },
			note: /settle wait expired/,
		},
		{
			name: "the shell predates the settle handshake (flag absent)",
			sample: {},
			note: /predates the settle handshake/,
		},
	])("--live reports a possibly-stale frame when $name", async ({ sample, note }) => {
		const frame = `data:image/jpeg;base64,${Buffer.from([4, 5, 6]).toString("base64")}`;
		const s = await setup({
			transport: {
				status: "completed",
				data: {
					status: "ready",
					result: {
						samples: [{ label: "shot", frame, currentTimeSec: 10, videoTimeSec: 10, ...sample }],
					},
				},
			},
		});
		const result = (await runAgentShot(parse({ project_id: "project", at: "10e", live: true }), {
			request: s.request,
			projectsDirectory: s.projects,
			pollIntervalMs: 1,
			renderFrame: s.renderFrame as unknown as RenderFrame,
		})) as { status: string; data: Record<string, never> };
		expect(result.status).toBe("completed");
		const image = result.data.image as {
			frame_settled: boolean;
			freshness: string;
			freshness_note: string;
		};
		// Never silent: an unproven frame reports frame_settled false.
		expect(image.frame_settled).toBe(false);
		expect(image.freshness).toBe("possibly_stale");
		expect(image.freshness_note).toMatch(note);
	});

	it("resolves --words to the phrase midpoint and reports the match", async () => {
		const s = await setup();
		const result = (await runAgentShot(parse({ project_id: "project", words: "round one" }), {
			request: s.request,
			projectsDirectory: s.projects,
			renderFrame: s.renderFrame as unknown as RenderFrame,
		})) as { status: string; data: Record<string, never> };
		expect(result.status).toBe("completed");
		expect(result.data.matched_words).toMatchObject({
			text: "round one",
			clip_id: "clip",
			source_start: 30,
		});
		expect(result.data.instant).toMatchObject({ input_base: "source", source_sec: 30.45 });
	});

	it("fails ambiguous or missing --words without touching the editor", async () => {
		const s = await setup();
		const missing = await runAgentShot(parse({ project_id: "project", words: "not said" }), {
			request: s.request,
			projectsDirectory: s.projects,
		});
		expect(missing).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
		expect(s.request).not.toHaveBeenCalled();
	});

	it("reports a failed image without failing the observation", async () => {
		const s = await setup();
		const renderFrame = vi.fn(async () => {
			throw new Error("RENDER_FAILED: no native build");
		});
		const result = (await runAgentShot(parse({ project_id: "project", at: 10 }), {
			request: s.request,
			projectsDirectory: s.projects,
			previewLaunch: { executable: "/bin/false", args: [] },
			renderFrame: renderFrame as unknown as RenderFrame,
		})) as { status: string; data: Record<string, never> };
		expect(result.status).toBe("completed");
		expect(result.data.image).toMatchObject({
			source: "saved_render",
			status: "failed",
			error: "RENDER_FAILED: no native build",
		});
	});

	it("marks the image unavailable without a preview launch", async () => {
		const s = await setup();
		const result = (await runAgentShot(parse({ project_id: "project", at: 10 }), {
			request: s.request,
			projectsDirectory: s.projects,
		})) as { status: string; data: Record<string, never> };
		expect(result.status).toBe("completed");
		expect(result.data.image).toMatchObject({ source: "saved_render", status: "unavailable" });
	});

	it("passes broker failures through as the terminal reply", async () => {
		const s = await setup({
			state: { status: "failed", error: { code: "EDITOR_UNAVAILABLE", message: "closed" } },
		});
		const result = await runAgentShot(parse({ project_id: "project", at: 10 }), {
			request: s.request,
			projectsDirectory: s.projects,
		});
		expect(result).toMatchObject({ status: "failed", error: { code: "EDITOR_UNAVAILABLE" } });
	});

	it("rejects a saved project whose ID does not match, and a missing one", async () => {
		const s = await setup();
		const mismatched = editFixture({ duration: 5 });
		await writeFile(path.join(s.projects, "other.klippt"), JSON.stringify(mismatched));
		const mismatch = await runAgentShot(parse({ project_id: "other", at: 10 }), {
			request: s.request,
			projectsDirectory: s.projects,
		});
		expect(mismatch).toMatchObject({ status: "failed", error: { code: "PROJECT_MISMATCH" } });
		const missing = await runAgentShot(parse({ project_id: "absent", at: 10 }), {
			request: s.request,
			projectsDirectory: s.projects,
		});
		expect(missing).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
		expect(s.request).not.toHaveBeenCalled();
	});
});

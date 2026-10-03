// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBrokerRequest } from "./agentBroker";

const broker = vi.hoisted(() => vi.fn());
const frames = vi.hoisted(() => vi.fn());
vi.mock("./agentBroker", () => ({ requestAgentBroker: broker }));
vi.mock("./agentFrames", () => ({ renderAgentFrames: frames }));
vi.mock("../media/audioPeaks", () => ({ resolveFfmpeg: () => "/usr/bin/ffmpeg" }));

import { runAgentBatch } from "./agentBatch";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	vi.clearAllMocks();
});

async function setup(options: { withFrames?: boolean } = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), "klippt-batch-"));
	dirs.push(dir);
	const projectsDirectory = path.join(dir, "projects");
	let stateCalls = 0;
	const requests: AgentBrokerRequest[] = [];
	broker.mockImplementation(async (_socket: string, request: AgentBrokerRequest) => {
		requests.push(request);
		switch (request.command) {
			case "state":
				return {
					status: "completed",
					data: {
						status: "ready",
						revision: `rev-${stateCalls}`,
						documentHash: `hash-${++stateCalls}`,
						audio: { ready: 0, pending: 0 },
						timings: { elapsedMs: 1, peaksMs: 0, speechMs: 0 },
					},
				};
			case "plan":
				return {
					status: "completed",
					data: { planId: `plan-${requests.length}`, summary: { results: [] }, applied: false },
				};
			case "apply":
				return {
					status: "completed",
					data: {
						receipt: { requestId: request.request_id, changed: true },
						commit_status: "committed",
						verify: {
							range: { startSec: 10 + requests.length, endSec: 12 + requests.length },
							state: { durationSec: 97 },
							checks: { status: "ready", new: [], resolved: [] },
						},
					},
				};
			default:
				throw new Error(`Unexpected command ${request.command}`);
		}
	});
	frames.mockImplementation(async (options: { out?: string; at: number[] }) => ({
		snapshot: "snap",
		frames: options.at.map((at) => ({
			at,
			exportTimeSec: at,
			path: path.join(options.out ?? dir, `frame-${at}.png`),
			elapsedMs: 1,
			manifest: "m",
		})),
		contactSheet: path.join(options.out ?? dir, "sheet.jpg"),
	}));
	const run = async (args: string[]) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runAgentBatch(
			{ kind: "agent", args, cwd: dir, json: true },
			(text) => stdout.push(text),
			{
				brokerSocketPath: "/private/agent.sock",
				err: (text) => stderr.push(text),
				...(options.withFrames
					? {
							projectsDirectory,
							previewLaunch: {} as import("./agentPreview").AgentPreviewLaunch,
						}
					: {}),
			},
		);
		expect(stdout).toHaveLength(1);
		return { code, result: JSON.parse(stdout[0]) as Record<string, unknown>, stderr, dir };
	};
	const writeSteps = async (steps: unknown) => {
		await writeFile(path.join(dir, "steps.json"), JSON.stringify(steps));
		return "steps.json";
	};
	return { run, writeSteps, requests, dir, projectsDirectory };
}

const SETTINGS_STEP = ["settings", "set", "cursor.size=2", "--project_id", "project"];
const LAYOUT_STEP = [
	"layout",
	"set",
	"--scope",
	"project",
	"--camera_size",
	"S",
	"--project_id",
	"project",
];

describe("agent batch runner", () => {
	it("runs porcelain steps in order with derived request ids, one envelope and a group undo command", async () => {
		const s = await setup();
		const input = await s.writeSteps([
			{ label: "cursor", args: SETTINGS_STEP },
			{ label: "layout", args: LAYOUT_STEP },
		]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(0);
		expect(result).toMatchObject({
			api_version: "1.0",
			status: "completed",
			data: {
				stop_on: "error",
				verbosity: "summary",
				project_id: "project",
				hash_before: "hash-1",
				hash_after: expect.stringMatching(/^hash-/),
				steps_total: 2,
				steps_executed: 2,
				steps_completed: 2,
				stopped_early: false,
				first_failure: null,
			},
		});
		const data = result.data as {
			batch_id: string;
			steps: { command: string; request_id: string; status: string }[];
			group: { id: string; undo_command: string };
		};
		expect(result.request_id).toBe(data.batch_id);
		expect(data.steps.map((step) => step.command)).toEqual(["settings", "layout"]);
		expect(data.steps[0].request_id).toBe(`${data.batch_id}:0`);
		expect(data.steps[1].request_id).toBe(`${data.batch_id}:1`);
		expect(data.group.undo_command).toBe(
			`klippt agent undo --project_id project --to ${data.batch_id}`,
		);
		// The guarded apply for each step ran under the derived request id.
		const applies = s.requests.filter((request) => request.command === "apply");
		expect(applies.map((request) => request.request_id)).toEqual([
			`${data.batch_id}:0`,
			`${data.batch_id}:1`,
		]);
	});

	it("keeps a step's explicit request id outside the batch group", async () => {
		const s = await setup();
		const input = await s.writeSteps([[...SETTINGS_STEP, "--request_id", "caller-id"]]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(0);
		const apply = s.requests.find((request) => request.command === "apply");
		expect(apply?.request_id).toBe("caller-id");
		expect((result.data as { steps: { request_id: string }[] }).steps[0].request_id).toBe(
			"caller-id",
		);
	});

	it.each(["pauses", "cutpoint", "accept"])("groups %s commits by batch step", async (command) => {
		const s = await setup();
		const fallback = broker.getMockImplementation();
		broker.mockImplementation(async (socket: string, request: AgentBrokerRequest) => {
			if (["pauses", "cutpoint", "inspect", "accept"].includes(request.command)) {
				s.requests.push(request);
				if (request.command === "accept")
					return {
						status: "completed",
						data: { receipt: { requestId: request.request_id, changed: true } },
					};
				if (request.command === "inspect")
					return {
						status: "completed",
						data: { clips: [{ id: "clip", source: { start: 0, end: 10 } }] },
					};
				return {
					status: "completed",
					data: {
						status: "ready",
						clip_id: "clip",
						chosen: { cut_sec: 5 },
						operations: [{ type: "addTrim", args: { clipId: "clip", startSec: 5, endSec: 10 } }],
					},
				};
			}
			return fallback?.(socket, request);
		});
		const step = [
			command,
			"--project_id",
			"project",
			...(command === "cutpoint" ? ["--clip", "clip", "--time", "5", "--edge", "out"] : []),
			...(command === "accept" ? ["--ids", "cut-1"] : ["--accept", "reviewed"]),
		];
		const input = await s.writeSteps([step, [...step, "--request_id", "explicit"]]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(0);
		const commits = s.requests.filter((request) => ["apply", "accept"].includes(request.command));
		expect(commits.map((request) => request.request_id)).toEqual([
			`${result.request_id}:0`,
			"explicit",
		]);
		expect(result.data).toMatchObject({
			steps: [{ request_id: `${result.request_id}:0` }, { request_id: "explicit" }],
		});
	});

	it("derives apply's required request id before validation", async () => {
		const s = await setup();
		const input = await s.writeSteps([["apply", "--project_id", "project", "--plan_id", "plan"]]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(0);
		expect(s.requests.find((request) => request.command === "apply")?.request_id).toBe(
			`${result.request_id}:0`,
		);
		expect(result.data).toMatchObject({ steps: [{ request_id: `${result.request_id}:0` }] });
	});

	it("preserves a normalized explicit request-id flag", async () => {
		const s = await setup();
		const input = await s.writeSteps([[...SETTINGS_STEP, "--request-id", "caller-id"]]);
		const { code } = await s.run(["batch", "--input", input]);
		expect(code).toBe(0);
		expect(s.requests.find((request) => request.command === "apply")?.request_id).toBe("caller-id");
	});

	it("stops at the first failure and returns only that step's full reply", async () => {
		const s = await setup();
		broker.mockImplementation(async (_socket: string, request: AgentBrokerRequest) => {
			s.requests.push(request);
			if (request.command === "state")
				return { status: "completed", data: { status: "ready", documentHash: "hash" } };
			if (request.command === "plan")
				return { status: "completed", data: { planId: "plan-1", summary: {}, applied: false } };
			return {
				status: "failed",
				error: {
					code: "CHECK_ERRORS",
					message: "Introduced check errors",
					findings: [{ rule: "text.over-camera", severity: "error" }],
				},
			};
		});
		const input = await s.writeSteps([SETTINGS_STEP, LAYOUT_STEP, SETTINGS_STEP]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(3);
		expect(result).toMatchObject({
			status: "failed",
			error: { code: "CHECK_ERRORS", hint: expect.any(String), retryable: false },
			data: { steps_executed: 1, steps_completed: 0, stopped_early: true },
		});
		const data = result.data as {
			steps: unknown[];
			first_failure: { index: number; reply: { error: { code: string } } };
		};
		expect(data.steps).toHaveLength(1);
		expect(data.first_failure.index).toBe(0);
		expect(data.first_failure.reply.error.code).toBe("CHECK_ERRORS");
	});

	it("stops on introduced warnings only with --stop-on warning", async () => {
		const warningApply = {
			status: "completed",
			data: {
				receipt: { changed: true },
				verify: {
					range: { startSec: 1, endSec: 2 },
					checks: {
						status: "ready",
						new: [{ rule: "audio.clipping", severity: "warning", at: 1 }],
						resolved: [],
					},
				},
			},
		};
		const s = await setup();
		const input = await s.writeSteps([SETTINGS_STEP, SETTINGS_STEP]);
		// Default: warnings do not stop the batch.
		let applies = 0;
		broker.mockImplementation(async (_socket: string, request: AgentBrokerRequest) => {
			s.requests.push(request);
			if (request.command === "state")
				return { status: "completed", data: { status: "ready", documentHash: "hash" } };
			if (request.command === "plan")
				return { status: "completed", data: { planId: "p", summary: {}, applied: false } };
			applies += 1;
			return warningApply;
		});
		const continuing = await s.run(["batch", "--input", input]);
		expect(continuing.code).toBe(0);
		expect(continuing.result.data).toMatchObject({ steps_completed: 2 });
		expect(applies).toBe(2);
		// --stop-on warning: the batch halts after step 0.
		const stopping = await s.run(["batch", "--input", input, "--stop-on", "warning"]);
		expect(stopping.code).toBe(0);
		expect(stopping.result.data).toMatchObject({
			steps_executed: 1,
			steps_completed: 1,
			stopped_early: true,
		});
		expect(stopping.result.data).not.toHaveProperty("steps[1]");
	});

	it("includes introduced findings per step with --verbosity full", async () => {
		const s = await setup();
		broker.mockImplementation(async (_socket: string, request: AgentBrokerRequest) => {
			s.requests.push(request);
			if (request.command === "state")
				return { status: "completed", data: { status: "ready", documentHash: "hash" } };
			if (request.command === "plan")
				return { status: "completed", data: { planId: "p", summary: {}, applied: false } };
			return {
				status: "completed",
				data: {
					receipt: { changed: true },
					verify: {
						range: { startSec: 3, endSec: 4 },
						checks: {
							status: "ready",
							new: [{ rule: "audio.clipping", severity: "warning", at: 3 }],
							resolved: [],
						},
					},
				},
			};
		});
		const input = await s.writeSteps([SETTINGS_STEP]);
		const summary = await s.run(["batch", "--input", input]);
		expect(
			(summary.result.data as { steps: { introduced: object; findings?: unknown }[] }).steps[0],
		).toMatchObject({ introduced: { warning: 1 } });
		expect(
			(summary.result.data as { steps: { findings?: unknown }[] }).steps[0].findings,
		).toBeUndefined();
		const full = await s.run(["batch", "--input", input, "--verbosity", "full"]);
		expect(
			(full.result.data as { steps: { findings?: unknown[] }[] }).steps[0].findings,
		).toHaveLength(1);
	});

	it("renders a contact sheet for touched instants and lists paths, not pixels", async () => {
		const s = await setup({ withFrames: true });
		const input = await s.writeSteps([SETTINGS_STEP, LAYOUT_STEP]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(0);
		const data = result.data as {
			batch_id: string;
			frames: {
				status: string;
				directory: string;
				contact_sheet: string;
				frames: { step: number; at: number; path: string }[];
			};
			steps: { frames?: string[] }[];
		};
		expect(data.frames.status).toBe("rendered");
		expect(data.frames.directory).toContain(`klippt-batch-${data.batch_id}-frames`);
		expect(data.frames.contact_sheet).toMatch(/sheet\.jpg$/);
		expect(frames).toHaveBeenCalledOnce();
		expect(frames.mock.calls[0][0]).toMatchObject({
			projectPath: path.join(s.projectsDirectory, "project.klippt"),
			sheet: true,
		});
		// Two steps × two verify range instants, mapped back to their steps.
		expect(data.frames.frames.map((frame) => frame.step)).toEqual([0, 0, 1, 1]);
		expect(data.steps[0].frames).toHaveLength(2);
		expect(JSON.stringify(result)).not.toContain("base64");
	});

	it("keeps a committed batch successful when frame rendering is unavailable", async () => {
		const s = await setup(); // no projectsDirectory/previewLaunch
		const input = await s.writeSteps([SETTINGS_STEP]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(0);
		expect(result.data).toMatchObject({
			steps_completed: 1,
			frames: { status: "unavailable" },
		});
		expect(frames).not.toHaveBeenCalled();
	});

	it("fails input errors before any broker call", async () => {
		const s = await setup();
		expect(await s.run(["batch", "--input", "missing.json"])).toMatchObject({
			code: 2,
			result: { status: "failed", error: { code: "NOT_FOUND" } },
		});
		await writeFile(path.join(s.dir, "broken.json"), "{not json");
		expect(await s.run(["batch", "--input", "broken.json"])).toMatchObject({
			code: 2,
			result: { error: { code: "INVALID_INPUT" } },
		});
		const nested = await s.writeSteps([["batch", "--input", "other.json"]]);
		expect(await s.run(["batch", "--input", nested])).toMatchObject({
			code: 2,
			result: { error: { code: "INVALID_INPUT", message: expect.stringContaining("nested") } },
		});
		const invalidStep = await s.writeSteps([["zoom", "add", "--bogus", "1"]]);
		expect(await s.run(["batch", "--input", invalidStep])).toMatchObject({
			code: 2,
			result: { error: { code: "INVALID_INPUT", message: expect.stringContaining("Step 0") } },
		});
		const badFlag = await s.writeSteps([SETTINGS_STEP]);
		expect(await s.run(["batch", "--input", badFlag, "--bogus", "x"])).toMatchObject({
			code: 2,
			result: { error: { code: "INVALID_INPUT" } },
		});
		expect(broker).not.toHaveBeenCalled();
	});

	it("fails the whole batch when a step command is unknown to the installed parser", async () => {
		const s = await setup();
		const input = await s.writeSteps([SETTINGS_STEP, ["frobnicate", "--project_id", "project"]]);
		const { code, result } = await s.run(["batch", "--input", input]);
		expect(code).toBe(2);
		expect(result.error).toMatchObject({
			code: "INVALID_INPUT",
			message: expect.stringContaining("Step 1"),
		});
		expect(s.requests.filter((request) => request.command === "apply")).toHaveLength(0);
	});
});

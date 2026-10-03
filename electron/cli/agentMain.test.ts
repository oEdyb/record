// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { runAgentCommand } from "./agentMain";

const broker = vi.hoisted(() => vi.fn());
vi.mock("./agentBroker", () => ({ requestAgentBroker: broker }));

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run(
	args: string[],
	cwd = "/",
	options: { brokerSocketPath?: string; projectsDirectory?: string } = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runAgentCommand(
		{ kind: "agent", args, cwd, json: true },
		(text) => stdout.push(text),
		{ err: (text) => stderr.push(text), ...options },
	);
	expect(stdout).toHaveLength(1);
	return {
		code,
		result: JSON.parse(stdout[0]) as Record<string, unknown>,
		stderr: stderr.map((line) => JSON.parse(line) as Record<string, unknown>),
	};
}

describe("agent CLI execution", () => {
	it("returns a single discovery result without a project", async () => {
		const { code, result } = await run(["guide", "--json"]);
		expect(code).toBe(0);
		expect(result).toMatchObject({
			api_version: "1.0",
			status: "completed",
			data: { capabilities: { edit: "experimental_opt_in" } },
		});
	});
	it("returns one requested schema without a broker or project", async () => {
		for (const args of [
			["guide", "--command", "plan"],
			["operations"],
			["operations", "--type", "set-layout"],
			["operations", "--type", "addZoom"],
			["operations", "--type", "addAnnotation"],
		]) {
			expect(await run(args)).toMatchObject({
				code: 0,
				result: { status: "completed" },
			});
		}
	});

	it("routes bounded import JSON to the broker without loading media in the CLI", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-import-cli-"));
		dirs.push(dir);
		const media = {
			kind: "audio",
			path: "/source with spaces/music.wav",
			placement: { startSec: 0, endSec: 3, gain: 0.25 },
		};
		await writeFile(path.join(dir, "import.json"), JSON.stringify(media));
		broker.mockResolvedValue({
			status: "completed",
			data: { planId: "prepared", applied: false },
		});
		expect(
			await run(["import-plan", "--project_id", "project", "--input", "import.json"], dir, {
				brokerSocketPath: "/private/agent.sock",
			}),
		).toMatchObject({ code: 0, result: { data: { planId: "prepared" } } });
		expect(broker).toHaveBeenLastCalledWith(
			"/private/agent.sock",
			expect.objectContaining({
				command: "import-plan",
				input: { projectId: "project", media },
			}),
		);
		const calls = broker.mock.calls.length;
		await writeFile(path.join(dir, "large.json"), Buffer.alloc(1024 * 1024 + 1));
		expect(
			await run(["import-plan", "--project_id", "project", "--input", "large.json"], dir, {
				brokerSocketPath: "/private/agent.sock",
			}),
		).toMatchObject({
			code: 2,
			result: { status: "failed", error: { code: "INVALID_INPUT" } },
		});
		expect(broker.mock.calls.length).toBe(calls);
	});

	it("reports malformed and missing inputs with stable nonzero exits", async () => {
		expect(await run(["edit", "--json"])).toMatchObject({
			code: 2,
			result: { status: "failed", error: { code: "INVALID_INPUT" } },
		});
		expect(await run(["inspect", "--project", "/not-a-klippt-project", "--json"])).toMatchObject({
			code: 2,
			result: { error: { code: "NOT_FOUND" } },
		});
	});
	it("reads a canonical relative path and never rewrites the source", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-agent-"));
		dirs.push(dir);
		const file = path.join(dir, "project with spaces.klippt");
		const bytes = JSON.stringify(createEmptyDocument({ title: "Example", projectId: "example" }));
		await writeFile(file, bytes);
		expect(await run(["inspect", "--project", path.basename(file), "--json"], dir)).toMatchObject({
			code: 0,
			result: {
				status: "completed",
				snapshot: { state: "saved_snapshot", persistent_revision: null },
			},
		});
		expect(await readFile(file, "utf8")).toBe(bytes);
	});
});

describe("editor analysis commands", () => {
	it("routes layout set through guarded plan/apply and returns state", async () => {
		broker.mockReset();
		broker
			.mockResolvedValueOnce({ status: "completed", data: {} })
			.mockResolvedValueOnce({
				status: "completed",
				data: { planId: "layout-plan" },
			})
			.mockResolvedValueOnce({
				status: "completed",
				data: { receipt: { id: "layout-receipt" } },
			})
			.mockResolvedValueOnce({
				status: "completed",
				data: { state: { editedTimeSec: 13 } },
			});
		const { code, result, stderr } = await run(
			["layout", "set", "--project_id", "p", "--scope", "clip:c", "--camera-size", "L"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect({ code, result }).toMatchObject({
			code: 0,
			result: {
				status: "completed",
				commit_status: "committed",
				data: { state: { editedTimeSec: 13 } },
			},
		});
		// The planned envelope leaves stdout: exactly one terminal envelope remains.
		expect(stderr.map((line) => line.status)).toEqual(["planned"]);
		expect(broker.mock.calls.map((call) => call[1].command)).toEqual([
			"state",
			"plan",
			"apply",
			"state",
		]);
	});

	it("routes transcribe and pauses through the broker with a resolved policy", async () => {
		broker.mockReset();
		broker.mockResolvedValue({ status: "completed", data: {} });
		expect(
			(
				await run(["transcribe", "--project_id", "p"], "/", {
					brokerSocketPath: "/s",
				})
			).code,
		).toBe(0);
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				command: "transcribe",
				input: { projectId: "p" },
			}),
		);
		await run(["pauses", "--project_id", "p", "--preset", "tight", "--min_pause", "0.4"], "/", {
			brokerSocketPath: "/s",
		});
		const call = broker.mock.calls.at(-1)?.[1] as {
			command: string;
			input: {
				policy: { minimumPauseSec: number; shortenedPauseSec: number };
				limit: number;
			};
		};
		expect(call.command).toBe("pauses");
		expect(call.input.policy).toMatchObject({
			minimumPauseSec: 0.4,
			shortenedPauseSec: 0.18,
		});
		expect(call.input.limit).toBe(200);
		const offline = await run(["pauses", "--project_id", "p"]);
		expect(offline.code).toBe(4);
		expect(offline.result.error).toMatchObject({ code: "OWNER_UNAVAILABLE" });
	});
});

describe("Task E command routing", () => {
	it.each([
		["settings", "set", "--project_id", "p", "motionBlurAmount=0.3"],
		["preset", "apply", "night", "--project_id", "p"],
		["auto", "regenerate", "--project_id", "p"],
	])("routes %s through plan/apply and preserves verify", async (...args) => {
		broker.mockReset();
		broker.mockImplementation(async (_socket, r) =>
			r.command === "plan"
				? {
						status: "completed",
						data: { planId: "plan", summary: { results: [] } },
					}
				: {
						status: "completed",
						data: {
							receipt: { requestId: r.request_id },
							verify: { status: "verified" },
						},
					},
		);
		const result = await run(args, "/", { brokerSocketPath: "/test.sock" });
		expect(result).toMatchObject({
			code: 0,
			result: {
				data: { verify: { status: "verified" } },
				commit_status: "committed",
			},
		});
		expect(broker.mock.calls.map((c) => c[1].command)).toEqual(["plan", "apply"]);
	});
	it("routes read settings and preset list without a plan", async () => {
		for (const args of [
			["settings", "--project_id", "p"],
			["preset", "list"],
		]) {
			broker.mockReset();
			broker.mockResolvedValue({ status: "completed", data: { read: true } });
			expect(await run(args, "/", { brokerSocketPath: "/test.sock" })).toMatchObject({ code: 0 });
			expect(broker).toHaveBeenCalledTimes(1);
			expect(broker.mock.calls[0][1].command).toBe(args[0]);
		}
	});
	it("reads transcript --all by project ID without contacting Electron", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "agent-all-"));
		dirs.push(dir);
		await writeFile(
			path.join(dir, "p.klippt"),
			JSON.stringify(createEmptyDocument({ projectId: "p", title: "Test" })),
		);
		const chunks: string[] = [];
		const code = await runAgentCommand(
			{
				kind: "agent",
				args: ["transcript", "--project_id", "p", "--all"],
				cwd: dir,
				json: true,
			},
			(text) => chunks.push(text),
			{ projectsDirectory: dir },
		);
		expect(code).toBe(0);
		expect(JSON.parse(chunks[0])).toMatchObject({
			data: { total_clips: 0, pages: 1 },
		});
	});
});

it("sends plan --stage and proposed-cut commands to the broker", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "klippt-stage-cli-"));
	dirs.push(dir);
	const operations = [{ type: "addTrim", args: { clipId: "clip", startSec: 1, endSec: 2 } }];
	await writeFile(path.join(dir, "cuts.json"), JSON.stringify(operations));
	broker.mockResolvedValue({ status: "completed", data: { lane_count: 1 } });
	await run(["plan", "--project_id", "p", "--input", "cuts.json", "--stage"], dir, {
		brokerSocketPath: "/agent.sock",
	});
	expect(broker).toHaveBeenLastCalledWith(
		"/agent.sock",
		expect.objectContaining({
			command: "plan",
			input: { projectId: "p", operations, stage: true },
		}),
	);
	for (const command of ["staged", "accept", "reject"]) {
		await run(
			[command, "--project_id", "p", ...(command === "staged" ? [] : ["--ids", "a,b"])],
			dir,
			{ brokerSocketPath: "/agent.sock" },
		);
		expect(broker).toHaveBeenLastCalledWith(
			"/agent.sock",
			expect.objectContaining({
				command,
				input: {
					projectId: "p",
					...(command === "staged" ? {} : { ids: ["a", "b"] }),
				},
			}),
		);
	}
});

describe("phase 2 output contract", () => {
	it("keeps accept's recovery id when the broker reply is lost", async () => {
		broker.mockReset();
		broker.mockRejectedValueOnce(new Error("TIMEOUT: reply was lost"));
		const { code, result } = await run(
			["accept", "--project_id", "p", "--request_id", "accept-recovery"],
			"/",
			{ brokerSocketPath: "/agent.sock" },
		);
		expect(code).not.toBe(0);
		expect(result).toMatchObject({
			status: "recovery_required",
			operation_request_id: "accept-recovery",
			commit_status: "unknown",
			error: { retryable: false, hint: expect.stringContaining("accept-recovery") },
		});
		expect(broker).toHaveBeenCalledTimes(1);
		expect(broker.mock.calls[0][1]).toMatchObject({
			command: "accept",
			request_id: "accept-recovery",
		});
	});

	it("documents exit codes and the envelope rule in guide and contracts replies", async () => {
		for (const args of [["guide"], ["guide", "--command", "apply"], ["contracts"]]) {
			const { code, result } = await run(args);
			expect(code).toBe(0);
			const contract = (
				result.data as {
					output_contract: {
						stdout: string;
						stderr: string;
						exit_codes: Record<string, string>;
						error_fields: string[];
						versioning: string;
					};
				}
			).output_contract;
			expect(contract.stdout).toContain("one terminal JSON envelope");
			expect(contract.stderr).toContain("stderr");
			expect(Object.keys(contract.exit_codes)).toEqual(["0", "2", "3", "4", "5", "6", "7"]);
			expect(contract.exit_codes["3"]).toContain("confirm_command");
			expect(contract.error_fields).toEqual([
				"code",
				"message",
				"hint",
				"retryable",
				"field_errors",
			]);
			expect(contract.versioning).toContain("additive-only");
		}
	});

	it("fails unknown flags with field errors and no fuzzy suggestions", async () => {
		const { code, result, stderr } = await run(["state", "--project_id", "p", "--projec_id", "q"]);
		expect(code).toBe(2);
		expect(stderr).toEqual([]);
		const error = result.error as {
			code: string;
			message: string;
			hint: string;
			retryable: boolean;
			field_errors: unknown[];
		};
		expect(error.code).toBe("INVALID_INPUT");
		expect(error.field_errors.length).toBeGreaterThan(0);
		expect(error.hint).toContain("guide --command");
		expect(error.retryable).toBe(false);
		expect(error.message).not.toMatch(/did you mean/i);
	});

	it("moves planned envelopes onto stdout only with --stream", async () => {
		broker.mockReset();
		broker.mockImplementation(async (_socket, request) =>
			request.command === "plan"
				? {
						status: "completed",
						data: {
							planId: "plan",
							span: { startSec: 0 },
							summary: { results: [] },
						},
					}
				: request.command === "apply"
					? { status: "completed", data: { receipt: {}, verify: {} } }
					: { status: "completed", data: { status: "ready" } },
		);
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runAgentCommand(
			{
				kind: "agent",
				args: ["zoom", "add", "--project_id", "p", "--at", "2", "--stream"],
				cwd: "/",
				json: true,
			},
			(text) => stdout.push(text),
			{ err: (text) => stderr.push(text), brokerSocketPath: "/s" },
		);
		expect(code).toBe(0);
		expect(stderr).toEqual([]);
		expect(stdout.map((line) => JSON.parse(line).status)).toEqual(["planned", "completed"]);
		// Without --stream the planned envelope stays off stdout.
		const quiet = await run(["zoom", "add", "--project_id", "p", "--at", "2"], "/", {
			brokerSocketPath: "/s",
		});
		expect(quiet.code).toBe(0);
		expect(quiet.stderr.map((line) => line.status)).toEqual(["planned"]);
		expect(quiet.result.status).toBe("completed");
	});

	it("maps each failure class to its documented exit code", async () => {
		// 4 — editor/owner unavailable
		const unavailable = await run(["state", "--project_id", "p", "--at", "1"]);
		expect(unavailable.code).toBe(4);
		expect(unavailable.result.error).toMatchObject({
			code: "OWNER_UNAVAILABLE",
		});
		// 5 — revision/snapshot conflict
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-exit-"));
		dirs.push(dir);
		await writeFile(
			path.join(dir, "p.klippt"),
			JSON.stringify(createEmptyDocument({ title: "T", projectId: "p" })),
		);
		const conflict = await run(
			["timeline", "--project", "p.klippt", "--snapshot", "b".repeat(64)],
			dir,
		);
		expect(conflict.code).toBe(5);
		expect(conflict.result.error).toMatchObject({
			code: "SNAPSHOT_CHANGED",
			retryable: false,
		});
		// 3 — blocked by checks; the reply carries the exact confirm_command
		broker.mockReset();
		broker.mockResolvedValueOnce({
			status: "failed",
			error: {
				code: "CHECK_ERRORS",
				message: "CHECK_ERRORS: Plan has error findings; apply their fixes or use --force.",
			},
			confirm_command: "klippt agent apply --project_id p --plan_id x --request_id r --force",
		});
		const blocked = await run(
			["apply", "--project_id", "p", "--plan_id", "x", "--request_id", "r"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(blocked.code).toBe(3);
		expect(blocked.result.confirm_command).toBe(
			"klippt agent apply --project_id p --plan_id x --request_id r --force",
		);
		// Broker error objects are normalized to the fixed five-field shape.
		expect(blocked.result.error).toMatchObject({
			code: "CHECK_ERRORS",
			retryable: false,
			hint: expect.stringContaining("confirm_command"),
			field_errors: [],
		});
		// 6 — timeout with a receipt to query
		broker.mockRejectedValueOnce(
			new Error("Broker timeout; recover request r before retrying a write"),
		);
		const timeout = await run(
			["apply", "--project_id", "p", "--plan_id", "x", "--request_id", "r"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(timeout.code).toBe(6);
		expect(timeout.result).toMatchObject({
			status: "recovery_required",
			commit_status: "unknown",
			operation_request_id: "r",
			error: {
				code: "EDITOR_TIMEOUT",
				hint: expect.stringContaining("receipt"),
			},
		});
	});

	it("runs every command fixture with exactly one stdout envelope", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-contract-"));
		dirs.push(dir);
		const projectFile = `${editFixture().project.id}.klippt`;
		await writeFile(path.join(dir, projectFile), JSON.stringify(editFixture()));
		await writeFile(
			path.join(dir, "cuts.json"),
			JSON.stringify([{ type: "addTrim", args: { clipId: "clip", startSec: 1, endSec: 2 } }]),
		);
		await writeFile(
			path.join(dir, "import.json"),
			JSON.stringify({
				kind: "audio",
				path: "/source/music.wav",
				placement: { startSec: 0, endSec: 3 },
			}),
		);
		await writeFile(path.join(dir, "steps.json"), JSON.stringify([{ op: "pause" }]));
		// shot and batch resolve the saved document through the projects directory.
		const projectsDirectory = path.join(dir, "projects");
		await mkdir(projectsDirectory, { recursive: true });
		await writeFile(path.join(projectsDirectory, projectFile), JSON.stringify(editFixture()));
		await writeFile(
			path.join(dir, "batch.json"),
			JSON.stringify([["history", "--project_id", "project"]]),
		);
		broker.mockReset();
		broker.mockImplementation(async (_socket, request) => {
			switch (request.command) {
				case "plan":
				case "import-plan":
					return {
						status: "completed",
						request_id: request.request_id,
						data: {
							planId: "plan",
							span: { startSec: 0, endSec: 1 },
							summary: { results: [] },
							applied: false,
						},
					};
				case "apply":
					return {
						status: "completed",
						request_id: request.request_id,
						data: {
							receipt: { requestId: request.request_id },
							verify: { status: "verified" },
						},
					};
				case "state":
					return {
						status: "completed",
						request_id: request.request_id,
						data: { status: "ready", revision: "r", documentHash: "h" },
					};
				case "check":
					return {
						status: "completed",
						request_id: request.request_id,
						data: {
							status: "ready",
							revision: "r",
							documentHash: "h",
							result: {
								findings: [],
								counts: { error: 0, warning: 0, info: 0, byRule: {} },
								total: 0,
								notes: [],
								rules: [],
							},
						},
					};
				case "cutpoint":
				case "edges":
					return {
						status: "completed",
						request_id: request.request_id,
						data: {
							status: "ready",
							operations: [],
							remove_operations: [],
							analyzed_clip_count: 0,
							totals: {},
						},
					};
				case "transport":
					return {
						status: "completed",
						request_id: request.request_id,
						data: { status: "ready" },
					};
				default:
					return {
						status: "completed",
						request_id: request.request_id,
						data: {},
					};
			}
		});
		const fixtures: {
			args: string[];
			code: number;
			planned?: boolean;
			projects?: boolean;
		}[] = [
			{ args: ["guide"], code: 0 },
			{ args: ["guide", "--command", "plan"], code: 0 },
			{ args: ["contracts"], code: 0 },
			{ args: ["operations"], code: 0 },
			{ args: ["operations", "--type", "addTrim"], code: 0 },
			{ args: ["skill"], code: 0 },
			{ args: ["check", "--explain", "cut.mid-sentence"], code: 0 },
			{ args: ["live"], code: 0 },
			{ args: ["state", "--project_id", "project", "--at", "1"], code: 0 },
			{ args: ["check", "--project_id", "project", "--all"], code: 0 },
			{ args: ["history", "--project_id", "project"], code: 0 },
			{ args: ["staged", "--project_id", "project"], code: 0 },
			{
				args: ["receipt", "--project_id", "project", "--request_id", "r"],
				code: 0,
			},
			{ args: ["pauses", "--project_id", "project"], code: 0 },
			{
				args: [
					"cutpoint",
					"--project_id",
					"project",
					"--clip",
					"clip",
					"--time",
					"20",
					"--edge",
					"out",
				],
				code: 0,
			},
			{ args: ["settings", "--project_id", "project"], code: 0 },
			{
				args: ["settings", "set", "--project_id", "project", "captions.fontSize=20"],
				code: 0,
			},
			{ args: ["preset", "list"], code: 0 },
			{
				args: ["preset", "apply", "night", "--project_id", "project"],
				code: 0,
			},
			{ args: ["auto", "remove", "--project_id", "project"], code: 0 },
			{
				args: ["plan", "--project_id", "project", "--input", "cuts.json"],
				code: 0,
			},
			{
				args: ["import-plan", "--project_id", "project", "--input", "import.json"],
				code: 0,
			},
			{
				args: ["apply", "--project_id", "project", "--plan_id", "plan", "--request_id", "r"],
				code: 0,
			},
			{
				args: ["undo", "--project_id", "project", "--request_id", "u"],
				code: 0,
			},
			{
				args: ["redo", "--project_id", "project", "--request_id", "u2"],
				code: 0,
			},
			{ args: ["accept", "--project_id", "project", "--ids", "a"], code: 0 },
			{ args: ["reject", "--project_id", "project", "--ids", "a"], code: 0 },
			{ args: ["open", "--project_id", "project"], code: 0 },
			{ args: ["transcribe", "--project_id", "project"], code: 0 },
			{
				args: ["transport", "--project_id", "project", "--script", "steps.json"],
				code: 0,
			},
			{
				args: [
					"text",
					"add",
					"--project_id",
					"project",
					"--from",
					"1",
					"--to",
					"3",
					"--text",
					"Hi",
				],
				code: 0,
				planned: true,
			},
			{
				args: [
					"broll",
					"add",
					"--project_id",
					"project",
					"--from",
					"1",
					"--to",
					"3",
					"--file",
					"/broll.mp4",
				],
				code: 0,
				planned: true,
			},
			{
				args: ["zoom", "add", "--project_id", "project", "--at", "2"],
				code: 0,
				planned: true,
			},
			{
				args: ["camera", "set", "full", "--project_id", "project", "--at", "2"],
				code: 0,
				planned: true,
			},
			{
				args: [
					"clip",
					"replace",
					"--project_id",
					"project",
					"--clip",
					"clip",
					"--file",
					"/new.mp4",
				],
				code: 0,
				planned: true,
			},
			{
				args: [
					"layout",
					"set",
					"--project_id",
					"project",
					"--scope",
					"project",
					"--captions",
					"on",
				],
				code: 0,
				planned: true,
			},
			{ args: ["edges", "--project_id", "project"], code: 0 },
			{ args: ["shot", "--project_id", "project", "--at", "1"], code: 0 },
			{ args: ["verify", "--project_id", "project", "--range", "1", "2"], code: 0 },
			{ args: ["batch", "--input", "batch.json"], code: 0 },
			{ args: ["inspect", "--project", projectFile], code: 0 },
			{ args: ["timeline", "--project", projectFile], code: 0 },
			{ args: ["item", "--project", projectFile, "--id", "clip"], code: 0 },
			{ args: ["transcript", "--project", projectFile, "--all"], code: 0 },
			{ args: ["geometry", "--project", projectFile, "--time", "3"], code: 0 },
			{ args: ["media", "--directory", dir], code: 0 },
			{ args: ["clone", "--project", projectFile], code: 0 },
			{ args: ["assets", "--project_id", "project"], code: 4, projects: false },
			{
				args: ["frame", "--project_id", "project", "--at", "1"],
				code: 4,
				projects: false,
			},
			{
				args: ["frames", "--project_id", "project", "--at", "1,2"],
				code: 4,
				projects: false,
			},
			{
				args: [
					"preview",
					"--project",
					projectFile,
					"--snapshot",
					"a".repeat(64),
					"--time",
					"3",
					"--out",
					"preview-out",
				],
				code: 4,
			},
		];
		for (const fixture of fixtures) {
			const stdout: string[] = [];
			const stderr: string[] = [];
			const code = await runAgentCommand(
				{ kind: "agent", args: fixture.args, cwd: dir, json: true },
				(text) => stdout.push(text),
				{
					err: (text) => stderr.push(text),
					brokerSocketPath: "/s",
					...(fixture.projects === false ? {} : { projectsDirectory: path.join(dir, "projects") }),
				},
			);
			const label = fixture.args.join(" ");
			expect(stdout, label).toHaveLength(1);
			const terminal = JSON.parse(stdout[0]) as Record<string, unknown>;
			expect(terminal.api_version, label).toBe("1.0");
			expect(typeof terminal.request_id, label).toBe("string");
			expect(code, label).toBe(fixture.code);
			expect(
				stderr.map((line) => JSON.parse(line).status),
				label,
			).toEqual(fixture.planned ? ["planned"] : []);
			if (terminal.status !== "completed") {
				expect(terminal.error, label).toMatchObject({
					code: expect.any(String),
					message: expect.any(String),
					hint: expect.any(String),
					retryable: false,
					field_errors: expect.any(Array),
				});
			}
		}
	});
});

describe("phase 3: one time base", () => {
	it("routes cutpoint --time with its explicit or default base", async () => {
		broker.mockReset();
		broker.mockResolvedValue({
			status: "completed",
			data: { status: "ready", requested_time: null },
		});
		const ready = await run(
			["cutpoint", "--project_id", "project", "--clip", "clip", "--time", "1:43", "--edge", "out"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(ready.code).toBe(0);
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				command: "cutpoint",
				input: expect.objectContaining({
					clipId: "clip",
					time: { seconds: 103, base: "edited" },
				}),
			}),
		);
		await run(
			["cutpoint", "--project_id", "project", "--clip", "clip", "--time", "20", "--edge", "in"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		// Compatibility: bare numbers keep the documented source-seconds meaning.
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				input: expect.objectContaining({
					time: { seconds: 20, base: "source" },
				}),
			}),
		);
		await run(
			[
				"cutpoint",
				"--project_id",
				"project",
				"--clip",
				"clip",
				"--time",
				"125.324r",
				"--edge",
				"out",
			],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				input: expect.objectContaining({
					time: { seconds: 125.324, base: "raw" },
				}),
			}),
		);
	});

	it("parses transport seek strings with suffixes and keeps bare numbers raw", async () => {
		broker.mockReset();
		broker.mockResolvedValue({
			status: "completed",
			data: { status: "ready", samples: [] },
		});
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-transport-"));
		dirs.push(dir);
		await writeFile(
			path.join(dir, "steps.json"),
			JSON.stringify([
				{ op: "seek", sec: "103e" },
				{ op: "seek", sec: 125.324 },
				{ op: "seek", sec: "1:43" },
				{ op: "seek", sec: "10.418s" },
			]),
		);
		const result = await run(
			["transport", "--project_id", "project", "--script", "steps.json"],
			dir,
			{ brokerSocketPath: "/s" },
		);
		expect(result.code).toBe(0);
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				command: "transport",
				input: expect.objectContaining({
					steps: [
						{ op: "seek", sec: { seconds: 103, base: "edited" } },
						{ op: "seek", sec: { seconds: 125.324, base: "raw" } },
						{ op: "seek", sec: { seconds: 103, base: "edited" } },
						{ op: "seek", sec: { seconds: 10.418, base: "source" } },
					],
				}),
			}),
		);
	});

	it("rejects a malformed suffixed time with exit code 2", async () => {
		broker.mockReset();
		const bad = await run(
			["cutpoint", "--project_id", "project", "--clip", "clip", "--time", "103x", "--edge", "out"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(bad.code).toBe(2);
		expect(bad.result.error).toMatchObject({ code: "INVALID_INPUT" });
		expect(broker).not.toHaveBeenCalled();
	});
});

describe("phase 4: proposals by default", () => {
	const edgeReport = {
		status: "ready",
		revision: "r1",
		operations: [
			{ type: "addTrim", args: { clipId: "clip", startSec: 1, endSec: 2, reason: "gap" } },
		],
		remove_operations: [],
		analyzed_clip_count: 1,
		missing_speech_activity: false,
		missing_microphone: false,
		totals: { suggestions: 1, gaps: 1, saved_seconds: 1, existing_edge_trims: 0 },
	};
	const mockProposalBroker = () => {
		broker.mockReset();
		broker.mockImplementation(async (_socket, request) => {
			switch (request.command) {
				case "edges":
					return { status: "completed", data: edgeReport };
				case "plan":
					return request.input.stage
						? {
								status: "completed",
								data: { staged: ["cut-1"], lane_count: 1, rejected_earlier: 0 },
							}
						: { status: "completed", data: { planId: "plan-1" } };
				case "apply":
					return {
						status: "completed",
						data: { receipt: { changed: true }, verify: { state: {} } },
					};
				default:
					return { status: "completed", data: {} };
			}
		});
	};

	it("edges with no flags stages the cuts and never applies", async () => {
		mockProposalBroker();
		const { code, result } = await run(["edges", "--project_id", "project"], "/", {
			brokerSocketPath: "/s",
		});
		expect(code).toBe(0);
		expect(result.data).toMatchObject({
			staged: true,
			applied: false,
			changed: false,
			trims: 1,
			proposal_ids: ["cut-1"],
			lane_count: 1,
		});
		const calls = broker.mock.calls.map((call) => call[1]);
		expect(calls.map((call) => call.command)).toEqual(["edges", "plan"]);
		expect(calls[1].input).toMatchObject({ stage: true, projectId: "project" });
	});

	it("edges --accept with a reason applies through guarded plan/apply", async () => {
		mockProposalBroker();
		const { code, result } = await run(
			["edges", "--project_id", "project", "--accept", "reviewed in staged", "--request_id", "a1"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(code).toBe(0);
		expect(result.data).toMatchObject({
			staged: false,
			applied: true,
			changed: true,
			accept_reason: "reviewed in staged",
			receipt: { changed: true },
		});
		const calls = broker.mock.calls.map((call) => call[1]);
		expect(calls.map((call) => call.command)).toEqual(["edges", "plan", "apply"]);
		expect(calls[1].input.stage).toBeUndefined();
		expect(calls[1].input.operations[0].args.reason).toContain("accepted: reviewed in staged");
		expect(calls[2]).toMatchObject({ command: "apply", request_id: "a1" });
	});

	it("edges --accept without a reason fails with exit 2 and touches nothing", async () => {
		mockProposalBroker();
		for (const args of [
			["edges", "--project_id", "project", "--accept"],
			["edges", "--project_id", "project", "--accept", ""],
			["edges", "--project_id", "project", "--accept", "  "],
		]) {
			const { code, result } = await run(args, "/", { brokerSocketPath: "/s" });
			expect(code).toBe(2);
			expect(result.error).toMatchObject({ code: "INVALID_INPUT" });
		}
		expect(broker).not.toHaveBeenCalled();
	});

	it("edges --remove true keeps the direct apply (it restores footage)", async () => {
		mockProposalBroker();
		const { code, result } = await run(
			["edges", "--project_id", "project", "--remove", "true"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		// The fixture report has no remove_operations: nothing to do.
		expect(code).toBe(0);
		expect(result.data).toMatchObject({ changed: false, staged: false });
	});

	it("pauses stages the ready page by default and applies it with --accept", async () => {
		broker.mockReset();
		broker.mockImplementation(async (_socket, request) => {
			switch (request.command) {
				case "pauses":
					return {
						status: "completed",
						data: {
							status: "ready",
							revision: "r1",
							suggestions: [{ id: "s1" }],
							totals: { suggestions: 1, saved_seconds: 0.7 },
							operations: [
								{
									type: "addTrim",
									args: { clipId: "clip", startSec: 1, endSec: 1.7, reason: "Shortened pause" },
								},
							],
							offset: 0,
							next_offset: null,
						},
					};
				case "plan":
					return request.input.stage
						? { status: "completed", data: { staged: ["cut-9"], lane_count: 1 } }
						: { status: "completed", data: { planId: "plan-2" } };
				case "apply":
					return { status: "completed", data: { receipt: { changed: true } } };
				default:
					return { status: "completed", data: {} };
			}
		});
		const stagedRun = await run(["pauses", "--project_id", "project"], "/", {
			brokerSocketPath: "/s",
		});
		expect(stagedRun.code).toBe(0);
		expect(stagedRun.result.data).toMatchObject({
			staged: true,
			applied: false,
			changed: false,
			proposal_ids: ["cut-9"],
		});
		expect(broker.mock.calls.map((call) => call[1].command)).toEqual(["pauses", "plan"]);
		broker.mockClear();
		const appliedRun = await run(
			["pauses", "--project_id", "project", "--accept", "silence checked", "--request_id", "p1"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(appliedRun.code).toBe(0);
		expect(appliedRun.result.data).toMatchObject({
			staged: false,
			applied: true,
			accept_reason: "silence checked",
		});
		expect(broker.mock.calls.map((call) => call[1].command)).toEqual(["pauses", "plan", "apply"]);
	});

	it("pauses without suggestions stages nothing", async () => {
		broker.mockReset();
		broker.mockResolvedValue({
			status: "completed",
			data: { status: "ready", suggestions: [], operations: [], totals: {} },
		});
		const { code, result } = await run(["pauses", "--project_id", "project"], "/", {
			brokerSocketPath: "/s",
		});
		expect(code).toBe(0);
		expect(result.data).toMatchObject({ status: "ready" });
		expect(broker.mock.calls.map((call) => call[1].command)).toEqual(["pauses"]);
	});

	it("cutpoint stages the chosen cut by default and applies it with --accept", async () => {
		broker.mockReset();
		broker.mockImplementation(async (_socket, request) => {
			switch (request.command) {
				case "cutpoint":
					return {
						status: "completed",
						data: {
							status: "ready",
							revision: "r1",
							clip_id: "clip",
							edge: "out",
							chosen: { cut_sec: 8, transcript_sec: 7.9, method: "transcript" },
						},
					};
				case "inspect":
					return {
						status: "completed",
						data: {
							id: "project",
							clips: [{ kind: "clip", id: "clip", source: { start: 0, end: 20 } }],
						},
					};
				case "plan":
					return request.input.stage
						? { status: "completed", data: { staged: ["cut-4"], lane_count: 1 } }
						: { status: "completed", data: { planId: "plan-3" } };
				case "apply":
					return { status: "completed", data: { receipt: { changed: true } } };
				default:
					return { status: "completed", data: {} };
			}
		});
		const args = [
			"cutpoint",
			"--project_id",
			"project",
			"--clip",
			"clip",
			"--time",
			"7.9",
			"--edge",
			"out",
		];
		const stagedRun = await run(args, "/", { brokerSocketPath: "/s" });
		expect(stagedRun.code).toBe(0);
		expect(stagedRun.result.data).toMatchObject({
			staged: true,
			applied: false,
			proposal_ids: ["cut-4"],
			chosen: { cut_sec: 8 },
		});
		const stagedCalls = broker.mock.calls.map((call) => call[1]);
		expect(stagedCalls.map((call) => call.command)).toEqual(["cutpoint", "inspect", "plan"]);
		// The staged trim removes the tail after the cut: [cut_sec, clip end].
		expect(stagedCalls[2].input.operations).toEqual([
			{
				type: "addTrim",
				args: { clipId: "clip", startSec: 8, endSec: 20, reason: "Cut point out at 8s" },
			},
		]);
		broker.mockClear();
		const appliedRun = await run(
			[...args, "--accept", "sentence ends here", "--request_id", "c1"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(appliedRun.code).toBe(0);
		expect(appliedRun.result.data).toMatchObject({ staged: false, applied: true });
		expect(broker.mock.calls.map((call) => call[1].command)).toEqual([
			"cutpoint",
			"inspect",
			"plan",
			"apply",
		]);
	});

	it("cutpoint without a chosen cut stages nothing and says so", async () => {
		broker.mockReset();
		broker.mockResolvedValue({
			status: "completed",
			data: { status: "ready", revision: "r1", clip_id: "clip", chosen: null },
		});
		const { code, result } = await run(
			["cutpoint", "--project_id", "project", "--clip", "clip", "--time", "7", "--edge", "in"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(code).toBe(0);
		expect(result.data).toMatchObject({ staged: false, applied: false, chosen: null });
		expect(broker.mock.calls.map((call) => call[1].command)).toEqual(["cutpoint"]);
	});
});

describe("phase 3: reply.time-base rule", () => {
	it("routes --rule reply.time-base to the broker and --explain works offline", async () => {
		broker.mockReset();
		broker.mockResolvedValue({
			status: "completed",
			data: {
				status: "ready",
				revision: "reply-contract",
				documentHash: "h",
				result: {
					findings: [
						{
							rule: "reply.time-base",
							severity: "warning",
							at: 0,
							span: { startSec: 0, endSec: 0 },
							clip: null,
							message: "$.data.currentTimeSec is seconds without a time_base label",
							fix: null,
						},
					],
					counts: { error: 0, warning: 1, info: 0, byRule: { "reply.time-base": 1 } },
					total: 1,
					notes: [],
					rules: [{ id: "reply.time-base", severity: "warning", describe: "…" }],
				},
			},
		});
		const audited = await run(["check", "--project_id", "p", "--rule", "reply.time-base"], "/", {
			brokerSocketPath: "/s",
		});
		expect(audited.code).toBe(0);
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				command: "check",
				input: expect.objectContaining({ rule: "reply.time-base" }),
			}),
		);
		expect(audited.result.data).toMatchObject({
			result: { counts: { warning: 1 } },
		});
		const explain = await run(["check", "--explain", "reply.time-base"]);
		expect(explain.code).toBe(0);
		expect(explain.result.data).toMatchObject({ id: "reply.time-base" });
		expect(broker.mock.calls).toHaveLength(1);
	});
});

describe("wave 4: deferred command registrations", () => {
	it("passes apply --deep through the broker relay", async () => {
		broker.mockReset();
		broker.mockResolvedValue({ status: "completed", data: {} });
		const { code } = await run(
			["apply", "--project_id", "p", "--plan_id", "x", "--request_id", "r", "--deep"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(code).toBe(0);
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				command: "apply",
				input: { projectId: "p", planId: "x", deep: true },
			}),
		);
	});

	it("relays verify with range clock objects and a resolved out path", async () => {
		broker.mockReset();
		broker.mockResolvedValue({ status: "completed", data: { edges: 0 } });
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-verify-"));
		dirs.push(dir);
		const { code } = await run(
			["verify", "--project_id", "p", "--range", "1:40", "105r", "--out", "film"],
			dir,
			{ brokerSocketPath: "/s" },
		);
		expect(code).toBe(0);
		expect(broker).toHaveBeenLastCalledWith(
			"/s",
			expect.objectContaining({
				command: "verify",
				input: {
					projectId: "p",
					range: {
						startSec: { seconds: 100, base: "edited" },
						endSec: { seconds: 105, base: "raw" },
					},
					out: path.join(dir, "film"),
				},
			}),
		);
	});

	it("runs a batch through the registered command path", async () => {
		broker.mockReset();
		broker.mockImplementation(async (_socket, request) =>
			request.command === "state"
				? {
						status: "completed",
						data: { status: "ready", revision: "r", documentHash: "h" },
					}
				: { status: "completed", data: {} },
		);
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-batch-"));
		dirs.push(dir);
		await writeFile(
			path.join(dir, "batch.json"),
			JSON.stringify([["history", "--project_id", "p"]]),
		);
		const { code, result } = await run(["batch", "--input", "batch.json"], dir, {
			brokerSocketPath: "/s",
		});
		expect(code).toBe(0);
		expect(result.data).toMatchObject({
			steps_total: 1,
			steps_completed: 1,
			hash_before: "h",
			hash_after: "h",
			steps: [{ command: "history", status: "completed", exit_code: 0 }],
		});
	});

	it("rejects a nested batch step before any write", async () => {
		broker.mockReset();
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-batch-nested-"));
		dirs.push(dir);
		await writeFile(
			path.join(dir, "nested.json"),
			JSON.stringify([["batch", "--input", "nested.json"]]),
		);
		const { code, result } = await run(["batch", "--input", "nested.json"], dir, {
			brokerSocketPath: "/s",
		});
		expect(code).toBe(2);
		expect(result.error).toMatchObject({ code: "INVALID_INPUT" });
		expect((result.error as { message?: string }).message).toContain("nested batch");
		expect(broker).not.toHaveBeenCalled();
	});
});

describe("wave 4: unknown-commit recovery guidance (review finding 1)", () => {
	it("advises receipt lookup, not a blind retry, when a placement apply loses its reply", async () => {
		broker.mockReset();
		broker.mockImplementation(async (_socket, request) => {
			if (request.command === "plan")
				return {
					status: "completed",
					data: { planId: "plan", span: { startSec: 0, endSec: 1 }, summary: { results: [] } },
				};
			if (request.command === "apply")
				throw new Error("Broker timeout; recover request op-1 before retrying a write");
			return { status: "completed", data: {} };
		});
		const { code, result } = await run(
			["zoom", "add", "--project_id", "project", "--at", "2", "--request_id", "op-1"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(code).toBe(7);
		expect(result).toMatchObject({
			status: "recovery_required",
			commit_status: "unknown",
			operation_request_id: "op-1",
			error: { code: "APPLY_OUTCOME_UNKNOWN" },
		});
		const error = result.error as { hint: string };
		expect(error.hint).toContain("receipt --project_id");
		expect(error.hint).toContain("--request_id op-1");
		expect(error.hint).toContain("history");
		expect(error.hint).toMatch(/BEFORE any retry/);
		expect(error.hint).toMatch(/reuse/);
		expect(error.hint).not.toContain("retry the same command");
	});

	it("forces receipt-first guidance for unknown commit states regardless of the error code", async () => {
		broker.mockReset();
		// Not a timeout: a mid-write failure that maps to exit 7 still must not
		// advise retrying the same command blindly.
		broker.mockRejectedValueOnce(new Error("socket blew up mid-write"));
		const { code, result } = await run(
			["apply", "--project_id", "p", "--plan_id", "x", "--request_id", "r-7"],
			"/",
			{ brokerSocketPath: "/s" },
		);
		expect(code).toBe(7);
		expect(result).toMatchObject({
			status: "recovery_required",
			commit_status: "unknown",
			operation_request_id: "r-7",
		});
		const error = result.error as { hint: string };
		expect(error.hint).toContain("receipt --project_id");
		expect(error.hint).toContain("--request_id r-7");
		expect(error.hint).not.toContain("retry the same command");
	});
});

describe("wave 4: broker connection failures are editor-unavailable (review finding 7)", () => {
	const realBroker = async () => {
		const actual = await vi.importActual<typeof import("./agentBroker")>("./agentBroker");
		broker.mockReset();
		broker.mockImplementation((socketPath: string, request: never) =>
			actual.requestAgentBroker(socketPath, request),
		);
	};

	it("maps a missing broker socket to exit 4 through the real socket transport", async () => {
		await realBroker();
		const missing = await run(["history", "--project_id", "p"], "/", {
			brokerSocketPath: path.join(tmpdir(), "klippt-r1-no-such-agent.sock"),
		});
		expect(missing.code).toBe(4);
		expect(missing.result.error).toMatchObject({ code: "EDITOR_UNAVAILABLE" });
		expect((missing.result.error as { hint: string }).hint).toContain("Start Klippt");
		// A failed connect proves the write never started: no recovery_required.
		const apply = await run(
			["apply", "--project_id", "p", "--plan_id", "x", "--request_id", "r-4"],
			"/",
			{ brokerSocketPath: path.join(tmpdir(), "klippt-r1-no-such-agent.sock") },
		);
		expect(apply.code).toBe(4);
		expect(apply.result).toMatchObject({
			status: "failed",
			commit_status: "not_started",
			error: { code: "EDITOR_UNAVAILABLE" },
		});
	});

	it("maps a stale broker socket (connection refused) to exit 4 through the real transport", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-stale-sock-"));
		dirs.push(dir);
		const socketPath = path.join(dir, "agent.sock");
		// A broker killed without cleanup leaves the socket file; connects refuse.
		const child = spawn(
			process.execPath,
			["-e", 'require("net").createServer().listen(process.argv[1])', socketPath],
			{ stdio: "ignore" },
		);
		try {
			for (let i = 0; i < 100 && !existsSync(socketPath); i++)
				await new Promise((resolve) => setTimeout(resolve, 20));
			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("exit", resolve));
			await realBroker();
			const refused = await run(["history", "--project_id", "p"], "/", {
				brokerSocketPath: socketPath,
			});
			expect(refused.code).toBe(4);
			expect(refused.result.error).toMatchObject({ code: "EDITOR_UNAVAILABLE" });
			expect((refused.result.error as { hint: string }).hint).toContain("Start Klippt");
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("keeps project-file not-found at exit 2, distinct from the broker class", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-r1-notfound-"));
		dirs.push(dir);
		const notFound = await run(["inspect", "--project", "missing.klippt"], dir, {
			brokerSocketPath: path.join(tmpdir(), "klippt-r1-no-such-agent.sock"),
		});
		expect(notFound.code).toBe(2);
		expect(notFound.result.error).toMatchObject({ code: "NOT_FOUND" });
	});
});

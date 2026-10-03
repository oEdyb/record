import { describe, expect, it, vi } from "vitest";
import { resolveStateReport } from "../../src/lib/ai-edition/agent/effectiveState";
import { buildResolvedEdit } from "../../src/lib/ai-edition/checks/context";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import { agentGuide, parseAgentCommand } from "./agentContracts";
import { formatCheckHuman, formatStateHuman, stateBrokerInput } from "./agentEditState";
import { runAgentCommand } from "./agentMain";

const broker = vi.hoisted(() => vi.fn());
vi.mock("./agentBroker", () => ({ requestAgentBroker: broker }));

describe("state and check CLI", () => {
	it("accepts one broker state selector", () => {
		expect(stateBrokerInput.parse({ projectId: "p", clipId: "clip" })).toEqual({
			projectId: "p",
			clipId: "clip",
		});
		expect(stateBrokerInput.safeParse({ projectId: "p" }).success).toBe(false);
		expect(stateBrokerInput.safeParse({ projectId: "p", at: 0, clipId: "clip" }).success).toBe(
			false,
		);
	});
	it("prints camera names and the origin of each layout value", () => {
		const document = editFixture();
		document.clipLayouts = { clip: { cameraAnchor: "bottom-right", cameraSize: "L" } };
		const report = resolveStateReport(buildResolvedEdit(document), { at: 1 });
		const output = formatStateHuman(report);
		expect(output).toContain("anchor=bottom-right [clip:clip]");
		expect(output).toContain("size=L (34%) [clip:clip]");
		expect(output).toContain(`shape=${report.state.layout.cameraShape.value} [project]`);
		expect(output).toContain("captions=off [project; scene base]");
	});
	it("parses range pairs and the valueless all flag", () => {
		expect(
			parseAgentCommand(["state", "--project_id", "p", "--at", "1:43", "--range", "1:40", "2:05"]),
		).toEqual({
			command: "state",
			input: {
				project_id: "p",
				at: { seconds: 103, base: "edited" },
				range: [
					{ seconds: 100, base: "edited" },
					{ seconds: 125, base: "edited" },
				],
			},
		});
		expect(parseAgentCommand(["state", "--project_id", "p", "--at", "125.324r"])).toMatchObject({
			command: "state",
			input: { at: { seconds: 125.324, base: "raw" } },
		});
		expect(parseAgentCommand(["check", "--project_id", "p", "--all"])).toEqual({
			command: "check",
			input: { project_id: "p", all: true, deep: false, page: 1, page_size: 50, limit: 30 },
		});
		expect(() =>
			parseAgentCommand(["check", "--project_id", "p", "--all", "--range", "1", "2"]),
		).toThrow();
		expect(() =>
			parseAgentCommand(["state", "--project_id", "p", "--at", "2", "--range", "1"]),
		).toThrow();
	});
	it.each(["state", "check"])("discovers the %s schema", (name) => {
		const command = agentGuide(name).commands[0];
		expect(command).toHaveProperty("input_schema");
		expect(JSON.stringify(command)).toContain("project_id");
	});
	it("lists both schemas through contracts without a broker", async () => {
		const out = vi.fn();
		expect(
			await runAgentCommand({ kind: "agent", args: ["contracts"], cwd: "/", json: true }, out),
		).toBe(0);
		const names = JSON.parse(out.mock.calls[0][0]).data.commands.filter(
			(item: { name: string }) => item.name === "state" || item.name === "check",
		);
		expect(names).toHaveLength(2);
		for (const command of names) expect(command.input_schema.properties.project_id).toBeDefined();
	});
	it("routes state and returns human names before ids", async () => {
		const data = {
			...resolveStateReport(buildResolvedEdit(editFixture()), { at: 1 }),
			revision: "rev",
			documentHash: "hash",
		};
		broker.mockResolvedValueOnce({ status: "completed", data });
		const out = vi.fn();
		expect(
			await runAgentCommand(
				{
					kind: "agent",
					args: ["state", "--project_id", "p", "--at", "0:01"],
					cwd: "/",
					json: false,
				},
				out,
				{ brokerSocketPath: "/socket" },
			),
		).toBe(0);
		expect(out.mock.calls[0][0]).toContain("Take one (clip)");
		expect(broker).toHaveBeenLastCalledWith(
			"/socket",
			expect.objectContaining({
				command: "state",
				input: { projectId: "p", at: { seconds: 1, base: "edited" } },
			}),
		);
		expect(formatStateHuman(data)).toContain("size=");
	});
	it("keeps exit zero when checks find errors", async () => {
		const result = {
			findings: [
				{
					rule: "camera.nested",
					severity: "error",
					at: 1,
					span: { startSec: 1, endSec: 2 },
					clip: "clip",
					message: "nested",
					fix: null,
				},
			],
			counts: { error: 1, warning: 0, info: 0 },
			total: 1,
			notes: [],
			rules: [],
		} as const;
		broker.mockResolvedValueOnce({ status: "completed", data: { status: "ready", result } });
		const out = vi.fn();
		expect(
			await runAgentCommand(
				{ kind: "agent", args: ["check", "--project_id", "p", "--all"], cwd: "/", json: true },
				out,
				{ brokerSocketPath: "/socket" },
			),
		).toBe(0);
		expect(JSON.parse(out.mock.calls[0][0]).data.result.counts.error).toBe(1);
	});
	it("keeps exit zero on invalid check arguments", async () => {
		expect(
			await runAgentCommand(
				{
					kind: "agent",
					args: ["check", "--project_id", "p", "--range", "2", "1"],
					cwd: "/",
					json: true,
				},
				vi.fn(),
			),
		).toBe(0);
	});
	it("groups human findings by severity with edited time first", () => {
		const result = {
			findings: [],
			counts: { error: 0, warning: 0, info: 0, byRule: {} },
			total: 0,
			notes: ["No peaks"],
			rules: [],
		};
		expect(formatCheckHuman(result)).toBe("0 errors, 0 warnings, 0 info\nNote: No peaks");
	});
});

it("returns pending findings on the first broker reply without polling", async () => {
	broker.mockReset().mockResolvedValue({
		status: "completed",
		data: {
			status: "analyzing",
			audio: { ready: 1, pending: 38 },
			result: { findings: [], counts: { error: 0, warning: 0, info: 0, byRule: {} } },
		},
	});
	const out = vi.fn();
	await runAgentCommand(
		{
			kind: "agent",
			args: ["check", "--project_id", "p", "--all", "--page", "2", "--page_size", "20", "--deep"],
			cwd: "/",
			json: true,
		},
		out,
		{ brokerSocketPath: "/socket" },
	);
	expect(broker).toHaveBeenCalledTimes(1);
	expect(broker.mock.calls[0][1].input).toMatchObject({ page: 2, page_size: 20, deep: true });
	expect(JSON.parse(out.mock.calls[0][0]).data.audio).toEqual({ ready: 1, pending: 38 });
});
it("explains rules and fixes without a project or broker", async () => {
	broker.mockClear();
	const out = vi.fn();
	await runAgentCommand(
		{ kind: "agent", args: ["check", "--explain", "cut.mid-sentence"], cwd: "/", json: false },
		out,
	);
	expect(out.mock.calls[0][0]).toContain("cut.mid-sentence (error)");
	expect(out.mock.calls[0][0]).toContain("setTrim");
	expect(broker).not.toHaveBeenCalled();
});
it("prints rule counts first, severity groups, a limit, and remaining findings last", async () => {
	const { runChecks } = await import("../../src/lib/ai-edition/checks");
	const result = runChecks(buildResolvedEdit(editFixture()));
	result.findings = Array.from({ length: 50 }, (_, at) => ({
		rule: "region.off-cut",
		severity: at === 49 ? "error" : "info",
		at,
		span: { startSec: at, endSec: at },
		clip: null,
		message: "removed",
		fix: null,
	}));
	result.total = 2000;
	result.counts.byRule["region.off-cut"] = 2000;
	const human = formatCheckHuman(result);
	expect(human.split("\n")[0]).toMatch(/^camera.nested:/);
	expect(human.indexOf("error region.off-cut")).toBeLessThan(human.indexOf("info region.off-cut"));
	expect(human.match(/: removed/g)).toHaveLength(30);
	expect(human.endsWith("1970 more, use --page")).toBe(true);
	expect(formatCheckHuman(result, 2).match(/: removed/g)).toHaveLength(2);
});

it("uses the human limit as its page size so subsequent pages skip nothing", async () => {
	const { runChecks } = await import("../../src/lib/ai-edition/checks");
	const result = runChecks(buildResolvedEdit(editFixture()), { rule: "camera.nested" });
	broker.mockReset().mockResolvedValue({ status: "completed", data: { status: "ready", result } });
	await runAgentCommand(
		{ kind: "agent", args: ["check", "--project_id", "p", "--page", "2"], cwd: "/", json: false },
		vi.fn(),
		{ brokerSocketPath: "/socket" },
	);
	expect(broker.mock.calls[0][1].input.page_size).toBe(30);
	expect(formatCheckHuman({ ...result, total: 60, offset: 60 })).not.toContain("more, use --page");
});

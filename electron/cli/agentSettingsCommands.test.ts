import { describe, expect, it, vi } from "vitest";
import type { AgentBrokerRequest } from "./agentBroker";
import { agentGuide, agentOperations, parseAgentCommand } from "./agentContracts";
import {
	applySettingsPlan,
	automaticOperations,
	settingsOperations,
} from "./agentSettingsCommands";

describe("settings, presets and auto CLI", () => {
	it("discovers all commands and operations and parses positional arguments around flags", () => {
		for (const name of ["settings", "preset", "auto", "transcript"])
			expect(agentGuide(name)).toMatchObject({
				commands: [{ name, input_schema: expect.any(Object) }],
			});
		for (const type of [
			"autoDirectionRun",
			"autoDirectionRemove",
			"autoDirectionRegenerate",
			"setAutomaticDirectionSettings",
		] as const)
			expect(agentOperations(type).input_schema).toBeTruthy();
		expect(
			parseAgentCommand([
				"settings",
				"set",
				"motionBlurAmount=0.3",
				"--project_id",
				"p",
				"cameraSize=M",
			]).input,
		).toMatchObject({ assignments: ["motionBlurAmount=0.3", "cameraSize=M"] });
		expect(parseAgentCommand(["preset", "save", "--project_id", "p", "night"]).input).toMatchObject(
			{ action: "save", name: "night" },
		);
		expect(
			parseAgentCommand(["transcript", "--project_id", "p", "--all", "--page", "2"]).input,
		).toMatchObject({ all: true, page: 2 });
		expect(() =>
			parseAgentCommand(["transcript", "--project_id", "p", "--all", "--clip", "c"]),
		).toThrow();
		expect(() =>
			parseAgentCommand(["auto", "remove", "--project_id", "p", "--settings", "{}"]),
		).toThrow();
	});
	it("builds settings and auto operations through the shared schema", () => {
		const settings = parseAgentCommand([
			"settings",
			"set",
			"motionBlurAmount=0.3",
			"--project_id",
			"p",
		]);
		if (settings.command !== "settings") throw new Error("wrong command");
		expect(settingsOperations(settings.input)).toEqual([
			{ type: "set-layout", settings: { motionBlurAmount: 0.3 } },
		]);
		const auto = parseAgentCommand([
			"auto",
			"regenerate",
			"--project_id",
			"p",
			"--settings",
			'{"policy":{"maximumScreenScale":2}}',
		]);
		if (auto.command !== "auto") throw new Error("wrong command");
		expect(automaticOperations(auto.input)).toEqual([
			{ type: "autoDirectionRegenerate", settings: { policy: { maximumScreenScale: 2 } } },
		]);
	});
	it("keeps verification and region counts and propagates stable request identity", async () => {
		const request = vi.fn(async (r: AgentBrokerRequest) =>
			r.command === "plan"
				? {
						status: "completed",
						data: {
							planId: "plan",
							summary: {
								results: [
									{
										type: "autoDirectionRun",
										result: { regions: { zoom: { added: 2, removed: 0 } } },
									},
								],
							},
						},
					}
				: {
						status: "completed",
						data: { receipt: { requestId: r.request_id }, verify: { status: "verified" } },
					},
		);
		const result = await applySettingsPlan(
			"p",
			{ operations: [{ type: "autoDirectionRun" }] },
			{ request_id: "stable" },
			"fallback",
			request,
		);
		expect(request.mock.calls.map(([r]) => r.command)).toEqual(["plan", "apply"]);
		expect(result).toMatchObject({
			status: "completed",
			operation_request_id: "stable",
			commit_status: "committed",
			data: {
				verify: { status: "verified" },
				operations: [{ result: { regions: { zoom: { added: 2 } } } }],
			},
		});
	});
	it("stops after rejected plans and reports unknown apply outcomes", async () => {
		const reject = vi.fn(async () => ({ status: "failed", error: { code: "CONFLICT" } }));
		expect(await applySettingsPlan("p", {}, {}, "r", reject)).toMatchObject({ status: "failed" });
		expect(reject).toHaveBeenCalledTimes(1);
		const request = vi.fn(async (r: AgentBrokerRequest) => {
			if (r.command === "apply") throw new Error("timeout");
			return { status: "completed", data: { planId: "plan" } };
		});
		expect(await applySettingsPlan("p", {}, {}, "r", request)).toMatchObject({
			status: "recovery_required",
			commit_status: "unknown",
			operation_request_id: "r",
		});
	});
});

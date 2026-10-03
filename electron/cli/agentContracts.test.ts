import { describe, expect, it } from "vitest";
import { agentGuide, agentOperations, parseAgentCommand } from "./agentContracts";
import { parseCliArgs } from "./args";

describe("agent command contract", () => {
	it("discovers only implemented capabilities and strict schemas", () => {
		const guide = agentGuide();
		expect(guide.capabilities.edit).toBe("experimental_opt_in");
		// The guide natively carries the phase-2 output contract plus every
		// command's short description (shot/verify/batch included).
		expect(JSON.stringify(guide).length).toBeLessThan(10000);
		expect(guide.commands.map(({ name }) => name)).toContain("guide");
		for (const command of guide.commands) {
			expect(command).not.toHaveProperty("input_schema");
			const schema = agentGuide(command.name).commands[0].input_schema;
			const variants = schema?.oneOf ?? schema?.anyOf ?? [schema];
			for (const variant of variants) expect(variant).toHaveProperty("additionalProperties", false);
		}
	});
	it("discovers each operation from the runtime schema with explicit custom constraints", () => {
		const all = agentOperations();
		expect(all).not.toHaveProperty("input_schema");
		for (const type of all.operation_types) {
			const result = agentOperations(type);
			expect(result.input_schema?.additionalProperties).toBe(false);
			expect(JSON.stringify(result).length).toBeLessThan(12000);
		}
		expect(JSON.stringify(agentOperations("addZoom"))).toContain('"enum":[0.5,0.75,1,1.25,1.5,2]');
		expect(JSON.stringify(agentOperations("set-layout"))).toContain("positive finite W:H");
		expect(JSON.stringify(agentOperations("addAnnotation"))).toContain("textAnimation");
		expect(parseAgentCommand(["operations", "--type", "addZoom"])).toEqual({
			command: "operations",
			input: { type: "addZoom" },
		});
		expect(() => parseAgentCommand(["operations", "--type", "invented"])).toThrow();
		expect(() => parseAgentCommand(["guide", "--command", "invented"])).toThrow();
	});

	it("discovers import-plan flags and rejects missing import input", () => {
		expect(
			parseAgentCommand(["import-plan", "--project_id", "project", "--input", "import.json"]),
		).toEqual({ command: "import-plan", input: { project_id: "project", input: "import.json" } });
		expect(() => parseAgentCommand(["import-plan", "--project_id", "project"])).toThrow();
		expect(agentGuide("import-plan").commands[0].description).toContain("B-roll overlay");
	});

	it("discovers and parses shot, verify, batch and apply --deep", () => {
		expect(parseAgentCommand(["shot", "--project_id", "p", "--at", "1:43"])).toEqual({
			command: "shot",
			input: { project_id: "p", at: { seconds: 103, base: "edited" }, live: false },
		});
		expect(
			parseAgentCommand(["shot", "--project_id", "p", "--words", "hello world", "--live"]).input,
		).toMatchObject({ words: "hello world", live: true });
		expect(parseAgentCommand(["verify", "--project_id", "p", "--range", "1", "2"])).toEqual({
			command: "verify",
			input: {
				project_id: "p",
				range: [
					{ seconds: 1, base: "edited" },
					{ seconds: 2, base: "edited" },
				],
			},
		});
		expect(
			parseAgentCommand([
				"apply",
				"--project_id",
				"p",
				"--plan_id",
				"x",
				"--request_id",
				"r",
				"--deep",
			]).input,
		).toMatchObject({ deep: true });
		for (const name of ["shot", "verify", "batch"])
			expect(agentGuide(name).commands[0].input_schema).toBeDefined();
		// The output contract ships natively in guide, not as a caller-side add-on.
		expect(agentGuide().output_contract.exit_codes["4"]).toContain("unavailable");
	});

	it("keeps machine errors inside the agent runner", () => {
		expect(parseCliArgs(["electron", ".", "agent", "unknown", "--json"], 2, "/work")).toEqual({
			kind: "agent",
			args: ["unknown", "--json"],
			cwd: "/work",
			json: true,
		});
	});
	it("preserves paths and applies bounded page defaults", () => {
		expect(
			parseAgentCommand(["timeline", "--project", "/some folder/demo.klippt", "--json"]),
		).toEqual({
			command: "timeline",
			input: { project: "/some folder/demo.klippt", offset: 0, limit: 25 },
		});
	});
	it.each([
		["timeline", "--project", "p", "--limit", "101"],
		["timeline", "--project", "p", "--offset", "NaN"],
		["timeline", "--project", "p", "--offset", "0.5"],
		["inspect", "--project", "p", "--force", "true"],
		["inspect", "--project", "p", "--project", "other"],
		["item", "--project", "p"],
		["inspect", "--project"],
		["apply"],
	])("rejects ambiguous or unsupported arguments: %j", (...args) => {
		expect(() => parseAgentCommand(args)).toThrow();
	});
});

it("discovers fourteen check rules with explainable fixes and bounded page flags", async () => {
	const { checkRules } = await import("../../src/lib/ai-edition/checks");
	const { explainCheck } = await import("./agentEditState");
	expect(checkRules).toHaveLength(14);
	expect(checkRules.map((rule) => rule.id)).toContain("caption.orphaned");
	for (const rule of checkRules)
		expect(explainCheck(rule.id)).toMatchObject({
			id: rule.id,
			describe: rule.describe,
			severity: rule.severity,
			fix: expect.any(String),
		});
	expect(parseAgentCommand(["check", "--explain", "caption.orphaned"]).command).toBe("check");
	for (const flags of [
		["--page", "0"],
		["--page_size", "51"],
		["--limit", "0"],
		["--page", "1.5"],
	])
		expect(() => parseAgentCommand(["check", "--project_id", "p", ...flags])).toThrow();
});

it("discovers and parses proposed-cuts commands and the opt-in stage flag", () => {
	expect(agentGuide().commands.map((item) => item.name)).toEqual(
		expect.arrayContaining(["plan", "staged", "accept", "reject"]),
	);
	expect(
		parseAgentCommand(["plan", "--project_id", "p", "--input", "cuts.json", "--stage"]),
	).toEqual({ command: "plan", input: { project_id: "p", input: "cuts.json", stage: true } });
	expect(parseAgentCommand(["staged", "--project_id", "p"])).toEqual({
		command: "staged",
		input: { project_id: "p" },
	});
	for (const command of ["accept", "reject"])
		expect(parseAgentCommand([command, "--project_id", "p", "--ids", "a,b"])).toEqual({
			command,
			input: { project_id: "p", ids: ["a", "b"] },
		});
	expect(parseAgentCommand(["accept", "--project_id", "p"]).input).toEqual({ project_id: "p" });
	expect(() => parseAgentCommand(["reject", "--project_id", "p"])).toThrow();
	expect(() => parseAgentCommand(["accept", "--project_id", "p", "--ids", "a,"])).toThrow();
});

describe("broll swap contract", () => {
	const args = [
		"broll",
		"swap",
		"--project_id",
		"project",
		"--overlay",
		"overlay",
		"--file",
		"/new.mp4",
	];
	it("defaults to automatic fit and trimming and advertises swap", () => {
		expect(parseAgentCommand(args)).toMatchObject({
			command: "broll",
			input: { action: "swap", fit: "auto", time: "trim", offset: 0, force: false },
		});
		expect(agentGuide("broll").commands[0].description).toContain("broll swap");
		expect(agentGuide().capabilities.broll_swap).toBe(true);
		expect(agentGuide().limits.broll_swap_aspect_tolerance).toBe(0.08);
	});
	it("accepts forced fit, hold, offset and receipt identity", () => {
		expect(
			parseAgentCommand([
				...args,
				"--fit",
				"cover",
				"--time",
				"hold",
				"--offset",
				"2.5",
				"--request_id",
				"swap-1",
				"--force",
			]),
		).toMatchObject({
			input: { fit: "cover", time: "hold", offset: 2.5, request_id: "swap-1", force: true },
		});
	});
	it.each([
		["--offset", "-1"],
		["--fit", "stretch"],
		["--time", "loop"],
		["--from", "3"],
	])("rejects invalid swap flags %s %s", (flag, value) => {
		expect(() => parseAgentCommand([...args, flag, value])).toThrow();
	});
	it("requires an overlay and an absolute path", () => {
		expect(() =>
			parseAgentCommand(["broll", "swap", "--project_id", "project", "--file", "/new.mp4"]),
		).toThrow();
		expect(() => parseAgentCommand(args.map((v) => (v === "/new.mp4" ? "new.mp4" : v)))).toThrow();
	});
});

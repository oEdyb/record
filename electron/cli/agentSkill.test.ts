import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { version } from "../../package.json";
import { agentGuide, parseAgentCommand } from "./agentContracts";
import { runAgentCommand } from "./agentMain";
import { agentSkill } from "./agentSkill";

const broker = vi.hoisted(() => vi.fn());
vi.mock("./agentBroker", () => ({ requestAgentBroker: broker }));

async function run(args: string[]) {
	const output: string[] = [];
	const callsBefore = broker.mock.calls.length;
	const code = await runAgentCommand(
		{ kind: "agent", args, cwd: "/not-a-checkout", json: true },
		(text) => output.push(text),
		{ brokerSocketPath: "/must-not-be-used.sock" },
	);
	expect(broker.mock.calls.length).toBe(callsBefore);
	expect(output).toHaveLength(1);
	return { code, envelope: JSON.parse(output[0]) };
}

describe("bundled CLI skill", () => {
	it("returns identical versioned content through both discovery paths without a broker", async () => {
		const direct = await run(["skill", "--json"]);
		const alias = await run(["guide", "--skill", "--json"]);
		expect(direct.code).toBe(0);
		expect(alias.code).toBe(0);
		expect(direct.envelope).toMatchObject({
			status: "completed",
			api_version: "1.0",
			data: { app_version: version, format: "markdown", name: "klippt-edit" },
		});
		expect(alias.envelope.data).toEqual(direct.envelope.data);
		expect(direct.envelope.data).toEqual(agentSkill());
	});
	it("bundles exactly the source Markdown and identifies its bytes with SHA-256", async () => {
		const source = await readFile(new URL("./skill/SKILL.md", import.meta.url), "utf8");
		expect(agentSkill().content).toBe(source);
		expect(agentSkill().content_sha256).toBe(createHash("sha256").update(source).digest("hex"));
	});
	it("explicitly excludes unsaved editor changes from saved frame proof", () => {
		expect(agentSkill().content).toContain(
			"`assets`, `frame`, and `frames` load the canonical saved project by ID. They exclude unsaved\neditor changes.",
		);
		expect(agentSkill().content).toContain("saved frame proofs cannot verify its unsaved changes");
	});
	it("registers skill and keeps guide's ordinary schema discovery", async () => {
		expect(parseAgentCommand(["skill"])).toEqual({ command: "skill", input: {} });
		expect(parseAgentCommand(["guide", "--skill"])).toEqual({
			command: "guide",
			input: { skill: true },
		});
		expect(agentGuide().commands.map((command) => command.name)).toContain("skill");
		expect((await run(["guide", "--command", "skill"])).envelope.data.commands[0]).toMatchObject({
			name: "skill",
			input_schema: { additionalProperties: false },
		});
	});
	it.each(
		[
			["skill", "--project_id", "fixture"],
			["guide", "--skill", "--command", "plan"],
			["guide", "--skill", "--skill"],
		].map((args) => ({ args })),
	)("rejects invalid discovery flags: $args", async ({ args }) => {
		expect(await run(args)).toMatchObject({
			code: 2,
			envelope: { status: "failed", error: { code: "INVALID_INPUT" } },
		});
	});
});

const blocks = [...agentSkill().content.matchAll(/```([^\n]*)\n([\s\S]*?)\n```/g)];
const examples = blocks.flatMap((match) => match[2].split("\n").filter((line) => line.trim()));
it("keeps every instruction code block an executable CLI command example", () => {
	expect(blocks.length).toBeGreaterThan(0);
	expect(blocks.every((match) => match[1] === "sh")).toBe(true);
	expect(examples.every((line) => line.startsWith("klippt agent "))).toBe(true);
});
it.each(examples)("parses bundled example: %s", (example) => {
	const result = spawnSync("/bin/sh", ["-c", `klippt() { printf '%s\\0' "$@"; }\n${example}`], {
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	const args = result.stdout.split("\0").slice(0, -1);
	expect(args.shift()).toBe("agent");
	expect(() => parseAgentCommand(args)).not.toThrow();
});

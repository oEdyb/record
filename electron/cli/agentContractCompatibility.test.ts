import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AGENT_API_VERSION, agentCommands } from "./agentContracts";
import baseline from "./fixtures/contract-v1.json";

function incompatible(before: unknown, after: unknown, location = ""): string[] {
	if (before === null || typeof before !== "object")
		return Object.is(before, after) ? [] : [location];
	if (Array.isArray(before)) {
		if (!Array.isArray(after)) return [location];
		if (location.endsWith(".required"))
			return after
				.filter((value) => !before.includes(value))
				.map((value) => `${location}.${value}`);
		if (location.endsWith(".enum"))
			return before
				.filter((value) => !after.includes(value))
				.map((value) => `${location}.${value}`);
		return before.flatMap((value, index) =>
			incompatible(value, after[index], `${location}.${index}`),
		);
	}
	if (!after || typeof after !== "object" || Array.isArray(after)) return [location];
	const result: string[] = [];
	if (
		!("required" in before) &&
		"required" in after &&
		Array.isArray(after.required) &&
		after.required.length
	)
		result.push(`${location}.required`);
	for (const [key, value] of Object.entries(before)) {
		if (key === "description" || key === "$schema") continue;
		const current = Object.entries(after).find(([name]) => name === key)?.[1];
		result.push(...incompatible(value, current, `${location}.${key}`));
	}
	return result;
}

describe("immutable version-one compatibility baseline", () => {
	it("rejects removals, repurposed defaults and new required inputs without a major bump", () => {
		if (AGENT_API_VERSION.split(".")[0] !== baseline.api_version.split(".")[0]) return;
		const current = Object.fromEntries(
			Object.entries(agentCommands).map(([name, command]) => [
				name,
				{ input_schema: z.toJSONSchema(command.input, { io: "input" }) },
			]),
		);
		expect(incompatible(baseline.commands, current)).toEqual([]);
	});
	it("cannot hide breaking drift by refreshing a snapshot", () => {
		const before = {
			properties: { mode: { type: "string", default: "saved" } },
			required: ["project"],
		};
		expect(incompatible(before, { ...before, properties: {} })).not.toEqual([]);
		expect(incompatible({ properties: {} }, { properties: {}, required: ["new"] })).not.toEqual([]);
		expect(
			incompatible(before, {
				...before,
				properties: { mode: { type: "string", default: "live" } },
			}),
		).not.toEqual([]);
		expect(incompatible(before, { ...before, required: ["project", "new"] })).not.toEqual([]);
		expect(
			incompatible(before, {
				...before,
				properties: { ...before.properties, optional: { type: "boolean" } },
			}),
		).toEqual([]);
	});
});

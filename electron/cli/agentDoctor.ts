import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { version } from "../../package.json";
import { agentBuildId } from "../../src/lib/ai-edition/agent/buildIdentity";
import { requestAgentBroker } from "./agentBroker";
import type { Capability, CommandPolicy } from "./agentCommandPolicy";
import { AGENT_API_VERSION, agentCommands } from "./agentContracts";

const component = z.object({
	contract: z.literal(1),
	session_id: z.string().min(1),
	build_id: z.string().nullable(),
	capabilities: z.record(z.string(), z.boolean()),
});
const report = z.object({
	status: z.literal("completed"),
	data: z.object({ editor: component, renderer: component.optional() }),
});
interface Readiness {
	capability: string;
	status: "available" | "unavailable" | "unknown";
	reason: string;
	next_action: string | null;
}

export async function agentDoctor(
	input: { command: string; live: boolean },
	socket: string | undefined,
	request = requestAgentBroker,
) {
	const entry = Object.entries(agentCommands).find(([name]) => name === input.command);
	if (!entry) throw new Error("UNKNOWN_COMMAND: Discover commands with guide.");
	const policy: CommandPolicy = entry[1].policy;
	const required = new Set<Capability>(policy.requires);
	if (input.command === "shot") required.add(input.live ? "fresh_frames" : "saved_render");
	const checks: Readiness[] = [];
	let components: z.infer<typeof report>["data"] | undefined;
	if (required.has("editor") || required.has("fresh_frames")) {
		try {
			if (!socket) throw new Error("Editor endpoint unavailable.");
			const response = await request(socket, {
				api_version: "1.0",
				request_id: randomUUID(),
				command: "capabilities",
				input: {},
			});
			const parsed = report.safeParse(response);
			if (parsed.success) components = parsed.data.data;
			else
				checks.push({
					capability: "editor",
					status: "unknown",
					reason: "Editor did not advertise a recognized capability contract.",
					next_action:
						"Use a build with capability reporting; do not infer support from its version.",
				});
		} catch (error) {
			checks.push({
				capability: "editor",
				status: "unavailable",
				reason: error instanceof Error ? error.message : String(error),
				next_action: "Open the current dev editor when editor access is available.",
			});
		}
	}
	for (const capability of required) {
		if (checks.some((check) => check.capability === capability)) continue;
		const value =
			capability === "editor"
				? components?.renderer?.capabilities.editor
				: capability === "fresh_frames"
					? components?.renderer?.capabilities.fresh_frames
					: undefined;
		checks.push({
			capability,
			status: value === true ? "available" : value === false ? "unavailable" : "unknown",
			reason:
				value === true
					? "Required capability explicitly advertised by this session."
					: value === false
						? "Component explicitly lacks the required capability."
						: "No recognized component capability report; file presence or a matching version cannot prove support.",
			next_action:
				value === true
					? null
					: "Obtain component capability evidence before relying on this operation.",
		});
	}
	return {
		command: input.command,
		status: checks.some((check) => check.status === "unavailable")
			? "unavailable"
			: checks.some((check) => check.status === "unknown")
				? "unknown"
				: "available",
		cli: {
			api_version: AGENT_API_VERSION,
			app_version: version,
			contract_sha256: createHash("sha256")
				.update(
					JSON.stringify(
						Object.entries(agentCommands).map(([name, command]) => ({
							name,
							policy: command.policy,
							schema: z.toJSONSchema(command.input, { io: "input" }),
						})),
					),
				)
				.digest("hex"),
			build_id: agentBuildId,
		},
		components: components ?? null,
		checks,
		cache: "none; re-probed per invocation so session/build changes cannot reuse stale readiness",
		saved_reads: "available independently of editor connectivity",
	};
}

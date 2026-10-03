import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentAutomaticSettingsSchema } from "../../src/lib/ai-edition/agent/automaticSettings";
import { parseSettingAssignments } from "../ai-edition/agentEditorSettings";
import type { AgentBrokerRequest } from "./agentBroker";

const writeOptions = {
	project_id: z.string().min(1).max(256),
	request_id: z.string().min(1).max(128).optional(),
	force: z.boolean().optional(),
};
export const settingsCommandInput = z
	.strictObject({
		...writeOptions,
		action: z.literal("set").optional(),
		assignments: z.array(z.string().min(1).max(16384)).max(100).default([]),
	})
	.refine(
		(v) => (v.action === "set" ? v.assignments.length > 0 : v.assignments.length === 0),
		"settings set requires key=value assignments.",
	);
export const autoCommandInput = z
	.strictObject({
		...writeOptions,
		action: z.enum(["run", "remove", "regenerate"]),
		settings: agentAutomaticSettingsSchema.optional(),
	})
	.refine(
		(v) => v.action !== "remove" || v.settings === undefined,
		"auto remove does not accept settings.",
	);
export const presetCommandInput = z
	.strictObject({
		...writeOptions,
		project_id: writeOptions.project_id.optional(),
		action: z.enum(["list", "save", "apply", "delete"]),
		name: z.string().trim().min(1).max(48).optional(),
		source: z.enum(["ui", "agent"]).optional(),
	})
	.refine(
		(v) => (v.action === "list" ? v.name === undefined : v.name !== undefined),
		"Supply a preset name except for list.",
	)
	.refine(
		(v) => !["save", "apply"].includes(v.action) || v.project_id !== undefined,
		"Save and apply require --project_id.",
	)
	.refine(
		(v) => !["save", "delete"].includes(v.action) || v.source !== "ui",
		"UI presets are read-only through the agent CLI.",
	);

const responseSchema = z.looseObject({
	status: z.string(),
	data: z.record(z.string(), z.unknown()).optional(),
});
export async function applySettingsPlan(
	projectId: string,
	material: Record<string, unknown>,
	input: { request_id?: string; force?: boolean },
	requestId: string,
	request: (r: AgentBrokerRequest) => Promise<unknown>,
) {
	const operationRequestId = input.request_id ?? requestId;
	const ask = async (command: string, body: Record<string, unknown>, id: string = randomUUID()) =>
		responseSchema.parse(
			await request({ api_version: "1.0", request_id: id, command, input: body }),
		);
	let plan = await ask("plan", { projectId, ...material });
	const deadline = Date.now() + 120_000;
	while (
		plan.status === "completed" &&
		plan.data?.status === "analyzing" &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		plan = await ask("plan", { projectId, ...material });
	}
	if (plan.data?.status === "analyzing")
		return {
			...plan,
			next_actions: [
				{ command: "Repeat the command after analysis finishes; no edit was applied." },
			],
		};
	if (plan.status !== "completed" || !plan.data) return plan;
	const planId = z.string().min(1).parse(plan.data.planId);
	const summary = z
		.object({ results: z.array(z.unknown()).default([]) })
		.safeParse(plan.data.summary);
	const results = summary.success ? summary.data.results : [];
	const automatic = results.flatMap((result) => {
		const parsed = z
			.object({
				type: z.string(),
				result: z.object({
					regions: z.record(z.string(), z.object({ added: z.number(), removed: z.number() })),
				}),
			})
			.safeParse(result);
		return parsed.success ? [{ type: parsed.data.type, regions: parsed.data.result.regions }] : [];
	});
	let applied: z.infer<typeof responseSchema>;
	try {
		applied = await ask(
			"apply",
			{ projectId, planId, ...(input.force ? { force: true } : {}) },
			operationRequestId,
		);
	} catch (error) {
		return {
			status: "recovery_required",
			operation_request_id: operationRequestId,
			commit_status: "unknown",
			error: { code: "APPLY_OUTCOME_UNKNOWN", message: String(error) },
			next_actions: [
				{
					command: `klippt agent receipt --project_id ${projectId} --request_id ${operationRequestId}`,
				},
			],
		};
	}
	const verify = z.record(z.string(), z.unknown()).safeParse(applied.data?.verify);
	return {
		...applied,
		operation_request_id: operationRequestId,
		...(applied.status === "completed"
			? {
					commit_status: "committed",
					data: {
						...applied.data,
						operations: results,
						...(automatic.length && verify.success
							? { verify: { ...verify.data, automatic_direction: automatic } }
							: {}),
					},
				}
			: {}),
	};
}

export function settingsOperations(input: z.infer<typeof settingsCommandInput>) {
	return [{ type: "set-layout", settings: parseSettingAssignments(input.assignments) }];
}
export function automaticOperations(input: z.infer<typeof autoCommandInput>) {
	return [
		{
			type:
				input.action === "run"
					? "autoDirectionRun"
					: input.action === "remove"
						? "autoDirectionRemove"
						: "autoDirectionRegenerate",
			...(input.settings ? { settings: input.settings } : {}),
		},
	];
}

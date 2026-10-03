import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentEditOperationSchema, agentLayoutSettingsSchema } from "../ai-edition/agentEditPlan";
import type { AgentBrokerRequest } from "./agentBroker";

export const layoutCommandInput = z
	.strictObject({
		action: z.literal("set"),
		force: z.boolean().optional(),
		project_id: z.string().min(1).max(256),
		scope: z
			.string()
			.regex(/^(?:project|clip:.+)$/)
			.max(261),
		camera_anchor: agentLayoutSettingsSchema.shape.cameraAnchor.describe(
			"--camera-anchor: named anchor or JSON {cx,cy} normalized coordinates.",
		),
		camera_size: agentLayoutSettingsSchema.shape.cameraSize.describe(
			"--camera-size: XS/S/M/L/XL or percent 10..80.",
		),
		camera_shape: agentLayoutSettingsSchema.shape.webcamMaskShape,
		captions: z.enum(["on", "off"]).optional(),
		request_id: z.string().min(1).max(128).optional(),
	})
	.refine(
		(input) =>
			input.camera_anchor !== undefined ||
			input.camera_size !== undefined ||
			input.camera_shape !== undefined ||
			input.captions !== undefined,
		"At least one layout setting is required.",
	);

export type LayoutCommandInput = z.infer<typeof layoutCommandInput>;

export function buildLayoutOperation(input: LayoutCommandInput) {
	const values = {
		...(input.camera_anchor !== undefined ? { cameraAnchor: input.camera_anchor } : {}),
		...(input.camera_size !== undefined ? { cameraSize: input.camera_size } : {}),
		...(input.captions !== undefined ? { captions: input.captions === "on" } : {}),
	};
	return agentEditOperationSchema.parse(
		input.scope === "project"
			? {
					type: "set-layout",
					settings: {
						...values,
						...(input.camera_shape !== undefined ? { webcamMaskShape: input.camera_shape } : {}),
					},
				}
			: {
					type: "setClipLayout",
					clipId: input.scope.slice(5),
					layout: {
						...values,
						...(input.camera_shape !== undefined ? { cameraShape: input.camera_shape } : {}),
					},
				},
	);
}

const brokerResponse = z
	.looseObject({
		status: z.string(),
		data: z.record(z.string(), z.unknown()).optional(),
	})
	.refine(
		(response) => response.status !== "completed" || response.data !== undefined,
		"Completed broker response has no data.",
	);

export async function applyLayoutCommand(
	input: LayoutCommandInput,
	requestId: string,
	request: (request: AgentBrokerRequest) => Promise<unknown>,
	onPlan?: (plan: Record<string, unknown>) => void,
) {
	const projectId = input.project_id;
	const operationRequestId = input.request_id ?? requestId;
	const ask = async (command: string, args: Record<string, unknown>, id: string = randomUUID()) =>
		brokerResponse.parse(
			await request({ api_version: "1.0", request_id: id, command, input: args }),
		);
	const stateInput = {
		projectId,
		...(input.scope === "project" ? { at: 0 } : { clipId: input.scope.slice(5) }),
	};
	const before = await ask("state", stateInput);
	if (before.status !== "completed" || !before.data) return before;
	const plan = await ask("plan", { projectId, operations: [buildLayoutOperation(input)] });
	if (plan.status !== "completed" || !plan.data) return plan;
	onPlan?.(plan.data);
	const planId = z.string().min(1).parse(plan.data.planId);
	let applied: z.infer<typeof brokerResponse>;
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
		};
	}
	if (applied.status !== "completed")
		return { ...applied, operation_request_id: operationRequestId };
	try {
		const state = await ask("state", stateInput);
		return {
			...state,
			operation_request_id: operationRequestId,
			commit_status: "committed",
			data: { ...state.data, receipt: applied.data?.receipt, verify: applied.data?.verify },
		};
	} catch (error) {
		return {
			status: "failed",
			operation_request_id: operationRequestId,
			commit_status: "committed",
			data: { receipt: applied.data?.receipt, verify: applied.data?.verify },
			error: { code: "STATE_UNAVAILABLE", message: String(error) },
		};
	}
}

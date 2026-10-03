import { z } from "zod";
import { parseTimeInput, timeInputObjectSchema } from "./agentTimeBase";

// Compatibility: a bare seek number stays RAW timeline seconds (the documented
// phase-2 meaning). Strings add the other clocks: "103e"/"1:43" edited,
// "10.4s" source. The broker resolves every seek to raw before the editor sees it.
const seekTime = z
	.union([z.number().finite().min(0), z.string().min(1).max(32), timeInputObjectSchema])
	.transform((value) => parseTimeInput(value, "raw"));

export const transportStepSchema = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("play") }),
	z.strictObject({ op: z.literal("pause") }),
	z.strictObject({ op: z.literal("seek"), sec: seekTime }),
	z.strictObject({
		op: z.literal("click"),
		testId: z.string().min(1).max(64),
		fraction: z.number().finite().min(0).max(1),
	}),
	z.strictObject({ op: z.literal("wait"), ms: z.number().int().min(0).max(60_000) }),
	z.strictObject({
		op: z.literal("sample"),
		label: z.string().min(1).max(64).optional(),
		frame: z.boolean().optional(),
	}),
	z.strictObject({
		op: z.literal("wheel"),
		testId: z.string().min(1).max(64),
		fraction: z.number().finite().min(0).max(1),
		deltaX: z.number().finite().optional(),
		deltaY: z.number().finite().optional(),
		ctrl: z.boolean().optional(),
	}),
	z.strictObject({ op: z.literal("probe"), ms: z.number().int().min(500).max(60_000) }),
]);

export const transportStepsSchema = z.array(transportStepSchema).min(1).max(50);

export const transportCommandInput = z.strictObject({
	project_id: z.string().min(1).max(256),
	script: z.string().min(1).max(4096),
});

export const transportBrokerInput = z.strictObject({
	projectId: z.string().min(1).max(256),
	runId: z.string().min(1).max(128),
	steps: transportStepsSchema,
});

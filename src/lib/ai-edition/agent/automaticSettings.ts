import { z } from "zod";
import type { AxcutDocument } from "../schema";
import { DEFAULT_AUTOMATIC_DIRECTION_POLICY } from "../timeline/automatic-direction";
import {
	automaticDirectionNumberRange,
	normalizeAutomaticDirectionPolicy,
	readAutomaticDirectionSettings,
} from "../timeline/automatic-direction-settings";

function policySchema(value: unknown, path = ""): z.ZodType {
	if (typeof value === "number") {
		const range = automaticDirectionNumberRange(path);
		return z.number().finite().min(Math.min(range.min, value)).max(Math.max(range.max, value));
	}
	if (typeof value === "boolean") return z.boolean();
	if (typeof value === "string") return z.literal(value);
	if (Array.isArray(value))
		return z.array(policySchema(value[0], `${path}.0`)).length(value.length);
	if (value && typeof value === "object")
		return z.strictObject(
			Object.fromEntries(
				Object.entries(value).map(([key, child]) => [
					key,
					policySchema(child, path ? `${path}.${key}` : key).optional(),
				]),
			),
		);
	return z.null();
}

export const automaticPolicyPatchSchema = policySchema(DEFAULT_AUTOMATIC_DIRECTION_POLICY);
export const agentAutomaticSettingsSchema = z.strictObject({
	presetId: z.string().min(1).max(64).nullable().optional(),
	policy: automaticPolicyPatchSchema.optional(),
});

function mergePolicy(base: unknown, patch: unknown): unknown {
	if (
		!base ||
		!patch ||
		typeof base !== "object" ||
		typeof patch !== "object" ||
		Array.isArray(base) ||
		Array.isArray(patch)
	)
		return patch;
	const updates = new Map(Object.entries(patch));
	return Object.fromEntries(
		Object.entries(base).map(([key, value]) => [
			key,
			updates.has(key) ? mergePolicy(value, updates.get(key)) : value,
		]),
	);
}

export function resolveAgentAutomaticSettings(
	document: AxcutDocument,
	patch?: z.infer<typeof agentAutomaticSettingsSchema>,
) {
	const stored = readAutomaticDirectionSettings(document);
	return {
		presetId:
			patch?.presetId === undefined ? (patch?.policy ? null : stored.presetId) : patch.presetId,
		policy: patch?.policy
			? normalizeAutomaticDirectionPolicy(mergePolicy(stored.policy, patch.policy))
			: stored.policy,
	};
}

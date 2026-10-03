import { z } from "zod";

export const automaticDirectionReasonSchema = z.enum([
	"screen-activity",
	"cursor-trace",
	"typing",
	"speech-with-quiet-screen",
]);
export type AutomaticDirectionReason = z.infer<typeof automaticDirectionReasonSchema>;
export const automaticDirectionProvenanceSchema = z.object({
	version: z.literal(1),
	reason: automaticDirectionReasonSchema,
});
export type AutomaticDirectionProvenance = z.infer<typeof automaticDirectionProvenanceSchema>;
export const automaticDirectionDismissalsSchema = z.array(z.string().min(1).max(2_048)).max(5_000);

export function directionProvenanceFields(value: unknown): {
	automaticDirection?: AutomaticDirectionProvenance;
} {
	const parsed = automaticDirectionProvenanceSchema.safeParse(value);
	return parsed.success ? { automaticDirection: parsed.data } : {};
}

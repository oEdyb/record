import path from "node:path";
import { z } from "zod";

export const clipCommandInput = z.strictObject({
	action: z.literal("replace"),
	project_id: z.string().min(1).max(256),
	clip: z.string().min(1).max(256),
	file: z.string().min(1).max(4096).refine(path.isAbsolute, "File must be absolute"),
	request_id: z.string().min(1).max(128).optional(),
	force: z.boolean().default(false),
});
export type ClipReplacementIntent = z.infer<typeof clipCommandInput> & { kind: "clip" };

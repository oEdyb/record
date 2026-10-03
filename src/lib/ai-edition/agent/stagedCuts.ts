import { z } from "zod";
import type { AxcutDocument } from "../schema";
import { cutRangeKey, type ProposedCut } from "../timeline/proposed-cuts";

export const stagedTrimOperationSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("addTrim"),
		args: z.strictObject({
			clipId: z.string().min(1),
			assetId: z.string().min(1).optional(),
			startSec: z.number().finite().nonnegative(),
			endSec: z.number().finite().nonnegative(),
			reason: z.string().max(256).default(""),
		}),
	}),
	z.strictObject({
		type: z.literal("setTrim"),
		args: z.strictObject({
			trimRangeId: z.string().min(1),
			startSec: z.number().finite().nonnegative(),
			endSec: z.number().finite().nonnegative(),
		}),
	}),
]);
export const stagedOperationsSchema = z.array(stagedTrimOperationSchema).min(1).max(500);

export function cutsFromOperations(
	document: AxcutDocument,
	operations: unknown,
	planId: string,
): ProposedCut[] {
	return stagedOperationsSchema.parse(operations).map((operation) => {
		const trim =
			operation.type === "setTrim"
				? document.timeline.trimRanges.find((item) => item.id === operation.args.trimRangeId)
				: undefined;
		const clipId = operation.type === "addTrim" ? operation.args.clipId : trim?.clipId;
		const clip = document.timeline.clips.find((item) => item.id === clipId);
		const { startSec, endSec } = operation.args;
		if (
			!clip ||
			clip.sourceEndSec === undefined ||
			startSec < clip.sourceStartSec ||
			endSec > clip.sourceEndSec ||
			endSec - startSec < 0.04 - 1e-9 ||
			(operation.type === "addTrim" &&
				operation.args.assetId &&
				operation.args.assetId !== clip.assetId)
		) {
			throw Object.assign(
				new Error("Each staged trim must fit one clip and last at least 0.04 seconds."),
				{ code: "INVALID_INPUT" },
			);
		}
		const reason = operation.type === "addTrim" ? operation.args.reason : "";
		const kind = reason.startsWith("check ")
			? "fix"
			: reason === "Shortened pause"
				? "pause"
				: "agent";
		const cut = {
			clipId: clip.id,
			assetId: clip.assetId,
			sourceStartSec: startSec,
			sourceEndSec: endSec,
		};
		return {
			...cut,
			id: crypto.randomUUID(),
			proposalKey: `${trim?.id ?? "new"}:${cutRangeKey(cut)}`,
			kind,
			origin:
				kind === "fix" ? reason : kind === "pause" ? "Shorten Pauses" : `agent plan ${planId}`,
			selected: true,
			...(trim ? { replacesTrim: trim } : {}),
		};
	});
}

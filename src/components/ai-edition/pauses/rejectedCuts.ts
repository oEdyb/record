import { z } from "zod";
import { cutRangeKey, type ProposedCut } from "@/lib/ai-edition/timeline/proposed-cuts";

const rejectedSchema = z.array(
	z.object({
		clipId: z.string(),
		sourceStartSec: z.number().finite(),
		sourceEndSec: z.number().finite(),
	}),
);
type RejectedCut = z.infer<typeof rejectedSchema>[number];
const memory = new Map<string, RejectedCut[]>();
const key = (projectId: string) => `klippt:proposed-cuts:rejected:${projectId}`;

function read(projectId: string): RejectedCut[] {
	try {
		const parsed = rejectedSchema.safeParse(
			JSON.parse(localStorage.getItem(key(projectId)) ?? "[]"),
		);
		if (parsed.success) {
			const merged = new Map(
				[...(memory.get(projectId) ?? []), ...parsed.data].map((cut) => [cutRangeKey(cut), cut]),
			);
			return [...merged.values()];
		}
	} catch {
		/* Keep session rejection memory when storage is unavailable. */
	}
	return memory.get(projectId) ?? [];
}

export function wasCutRejected(projectId: string, cut: ProposedCut): boolean {
	return read(projectId).some(
		(rejected) =>
			rejected.clipId === cut.clipId &&
			Math.max(
				0,
				Math.min(rejected.sourceEndSec, cut.sourceEndSec) -
					Math.max(rejected.sourceStartSec, cut.sourceStartSec),
			) >=
				(cut.sourceEndSec - cut.sourceStartSec) * 0.5 - 1e-9,
	);
}

export function rememberRejectedCut(projectId: string, cut: ProposedCut): void {
	const entries = new Map(read(projectId).map((item) => [cutRangeKey(item), item]));
	entries.set(cutRangeKey(cut), {
		clipId: cut.clipId,
		sourceStartSec: Math.round(cut.sourceStartSec * 1000) / 1000,
		sourceEndSec: Math.round(cut.sourceEndSec * 1000) / 1000,
	});
	const next = [...entries.values()];
	memory.set(projectId, next);
	try {
		localStorage.setItem(key(projectId), JSON.stringify(next));
	} catch {
		/* Session memory still suppresses the rejected proposal. */
	}
}

export function resetRejectedCutsForTests(): void {
	memory.clear();
}

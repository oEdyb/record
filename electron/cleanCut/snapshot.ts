import type { CleanCutPlan, CutRegion, SpokenWord } from "./types";

const KINDS = ["retake", "false-start", "repair", "stutter", "filler", "self-talk"] as const;
type RegionKind = (typeof KINDS)[number];

export interface SnapshotTake {
	assetId: string;
	/** Seconds to add to a microphone time to get the recording's source time. */
	offsetSec: number;
	words: SpokenWord[];
}

export interface SnapshotRegion {
	id: string;
	kind: RegionKind;
	assetId: string;
	removedStartSec: number;
	removedEndSec: number;
	words: string[];
	reason: string;
	sources: string[];
	risky: boolean;
}

export interface SnapshotWord {
	text: string;
	assetId: string;
	startSec: number;
	endSec: number;
	regionId: string | null;
}

export interface PlanView {
	keep: Array<{ assetId: string; startSec: number; endSec: number }>;
	regions: SnapshotRegion[];
	words: SnapshotWord[];
}

const UNIT_ID =
	/\s*\b(?:in|before|after|of|from|than|at|with)?\s*\(?\b(?:T\d+\.)?U\d+(?:\s*[-–]\s*(?:T\d+\.)?U?\d+)?\b\)?/g;

/** Reasons come from rules and model replies that refer to internal sentence ids; drop those. */
export function readableReason(reason: string): string {
	const text = reason
		.replace(UNIT_ID, "")
		.replace(/\s+([,.;:])/g, "$1")
		.replace(/\s{2,}/g, " ");
	return text.trim().replace(/[,;:]$/, "");
}

function regionKind(kind: string): RegionKind {
	if ((KINDS as readonly string[]).includes(kind)) return kind as RegionKind;
	if (kind === "hesitation") return "filler";
	return "retake";
}

/**
 * Turns an engine plan into what review shows. Each cut owns a slice of the removed gap it sits
 * in: from the previous cut's midpoint (or the kept clip before) to the next one's, so restoring
 * every cut in a gap gives back exactly the gap, and restoring one gives back only its part.
 */
export function viewPlan(plan: CleanCutPlan, takes: SnapshotTake[]): PlanView {
	const byId = new Map(takes.map((take) => [take.assetId, take]));
	const keep = plan.takes.flatMap((takePlan) => {
		const take = byId.get(takePlan.takeId);
		if (!take) return [];
		return takePlan.clips.map((clip) => ({
			assetId: take.assetId,
			startSec: clip.startSec + take.offsetSec,
			endSec: clip.endSec + take.offsetSec,
		}));
	});
	const regions: SnapshotRegion[] = [];
	const owner = new Map<string, string>();
	for (const takePlan of plan.takes) {
		const take = byId.get(takePlan.takeId);
		if (!take) continue;
		const clips = takePlan.clips;
		const cuts = plan.cuts
			.filter((cut) => cut.takeId === takePlan.takeId)
			.sort((a, b) => a.startSec - b.startSec);
		// Cut words carry recognizer times and clips carry aligned ones, so find the gap by midpoint.
		const gapOf = (cut: CutRegion) => {
			const mid = (cut.startSec + cut.endSec) / 2;
			const before = clips.filter((clip) => clip.endSec <= mid).at(-1);
			const after = clips.find((clip) => clip.startSec >= mid);
			return { start: before?.endSec ?? cut.startSec, end: after?.startSec ?? cut.endSec };
		};
		for (const [index, cut] of cuts.entries()) {
			const gap = gapOf(cut);
			const prev = cuts[index - 1];
			const next = cuts[index + 1];
			const sharesPrev = prev && gapOf(prev).start === gap.start;
			const sharesNext = next && gapOf(next).start === gap.start;
			const start = sharesPrev ? (prev.endSec + cut.startSec) / 2 : gap.start;
			const end = sharesNext ? (cut.endSec + next.startSec) / 2 : gap.end;
			const id = `${take.assetId}:${cut.firstWordIndex}`;
			for (let i = cut.firstWordIndex; i <= cut.lastWordIndex; i++)
				owner.set(`${take.assetId}:${i}`, id);
			regions.push({
				id,
				kind: regionKind(cut.kind),
				assetId: take.assetId,
				removedStartSec: start + take.offsetSec,
				removedEndSec: end + take.offsetSec,
				words: cut.text.split(/\s+/).filter(Boolean),
				reason: readableReason(cut.reason),
				sources: [...cut.sources],
				risky: cut.risky,
			});
		}
	}
	const words = takes.flatMap((take) =>
		take.words.map((word, index) => ({
			text: word.word,
			assetId: take.assetId,
			startSec: word.startSec + take.offsetSec,
			endSec: word.endSec + take.offsetSec,
			regionId: owner.get(`${take.assetId}:${index}`) ?? null,
		})),
	);
	return { keep, regions, words };
}

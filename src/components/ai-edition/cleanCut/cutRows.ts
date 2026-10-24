import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import type { CutMoment } from "./moments";

export type CutRow =
	| { type: "moment"; key: string; moment: CutMoment; open: boolean }
	| { type: "cut"; key: string; cut: ReviewCut; moment: CutMoment; nested: boolean };

export interface CutSection {
	unsure: boolean;
	/** Unsure cuts in the first section, as the card counts them; every cut in the other. */
	count: number;
	/** Time the section's moments still remove. */
	removedSec: number;
	rows: CutRow[];
}

/**
 * The sheet's rows. A moment is one row with one count and one removed time wherever it
 * shows: moments with an unsure cut come first, the sure ones after. A moment of one cut is
 * that cut's row; a larger one opens to show each. A search keeps the moments with a
 * matching cut and opens them on the matches; the moment's own figures stay whole.
 */
export function buildCutRows(
	moments: readonly CutMoment[],
	query: string,
	openKeys: ReadonlySet<string>,
): CutSection[] {
	const needle = query.trim().toLowerCase();
	const sections: CutSection[] = [
		{ unsure: true, count: 0, removedSec: 0, rows: [] },
		{ unsure: false, count: 0, removedSec: 0, rows: [] },
	];
	for (const moment of moments) {
		const section = sections[moment.unsure ? 0 : 1];
		const matches = needle
			? moment.cuts.filter((cut) => cut.region.words.join(" ").toLowerCase().includes(needle))
			: moment.cuts;
		if (matches.length === 0) continue;
		section.count += moment.unsure
			? moment.cuts.filter((cut) => cut.region.risky).length
			: moment.cuts.length;
		section.removedSec += moment.removedSec;
		if (moment.cuts.length === 1) {
			const cut = moment.cuts[0];
			section.rows.push({ type: "cut", key: `c:${cut.region.id}`, cut, moment, nested: false });
			continue;
		}
		const open = needle.length > 0 || openKeys.has(moment.key);
		section.rows.push({ type: "moment", key: `m:${moment.key}`, moment, open });
		if (!open) continue;
		for (const cut of matches)
			section.rows.push({ type: "cut", key: `c:${cut.region.id}`, cut, moment, nested: true });
	}
	return sections.filter((section) => section.rows.length > 0);
}

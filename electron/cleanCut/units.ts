import { fixed } from "./pyCompat";
import type { CleanCutTake } from "./types";

const PAUSE_SPLIT = 0.8;

export interface Unit {
	id: string;
	take: CleanCutTake;
	start: number;
	end: number;
	text: string;
	gapBefore: number;
	first: number;
	last: number;
}

export function splitUnits(takes: CleanCutTake[]): Unit[] {
	const units: Unit[] = [];
	takes.forEach((take, takeIndex) => {
		let current: number[] = [];
		let previousEnd = 0;
		let count = 0;
		const flush = () => {
			if (!current.length) return;
			count += 1;
			const run = current.map((i) => take.words[i]);
			const start = run[0].startSec;
			const end = run[run.length - 1].endSec;
			units.push({
				id: `T${String(takeIndex + 1).padStart(2, "0")}.U${String(count).padStart(2, "0")}`,
				take,
				start,
				end,
				text: run.map((w) => w.word).join(" "),
				gapBefore: Number(fixed(start - previousEnd, 2)),
				first: current[0],
				last: current[current.length - 1],
			});
			previousEnd = end;
			current = [];
		};
		take.words.forEach((word, index) => {
			if (
				current.length &&
				word.startSec - take.words[current[current.length - 1]].endSec > PAUSE_SPLIT
			) {
				flush();
			}
			current.push(index);
			if (/[.?!]$/.test(word.word.trimEnd())) flush();
		});
		flush();
	});
	return units;
}

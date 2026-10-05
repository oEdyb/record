import fs from "node:fs/promises";
import path from "node:path";
import type { RecordStartMark } from "../../src/lib/nativeMacRecording";

/** Keeps the log to the last few starts: enough to compare, never a growing file. */
const MAX_ENTRIES = 50;

export type RecordStartStep = { stage: string; sinceClickMs: number; stepMs: number };

/**
 * Every step from the Record click to the first saved frame, renderer and main
 * together, so a slow start shows which step took the time.
 */
export class RecordStartTimeline {
	private readonly marks: RecordStartMark[];

	constructor(
		private readonly now: () => number,
		rendererMarks: RecordStartMark[] = [],
	) {
		this.marks = rendererMarks
			.filter((mark) => typeof mark?.stage === "string" && Number.isFinite(mark?.atMs))
			.map((mark) => ({ stage: mark.stage.slice(0, 64), atMs: mark.atMs }));
	}

	mark(stage: string): void {
		this.marks.push({ stage, atMs: this.now() });
	}

	steps(): RecordStartStep[] {
		const origin = this.marks[0]?.atMs ?? 0;
		return this.marks.map((mark, index) => ({
			stage: mark.stage,
			sinceClickMs: Math.round(mark.atMs - origin),
			stepMs: Math.round(mark.atMs - (this.marks[index - 1]?.atMs ?? origin)),
		}));
	}
}

/** Appends one start as a JSON line and trims the file to the newest entries. */
export async function appendRecordStartTiming(
	file: string,
	entry: { recordedAt: string; success: boolean; steps: RecordStartStep[]; action?: string },
): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const previous = await fs.readFile(file, "utf8").catch(() => "");
	const lines = [...previous.split("\n").filter(Boolean), JSON.stringify(entry)];
	await fs.writeFile(file, `${lines.slice(-MAX_ENTRIES).join("\n")}\n`);
}

import type { AxcutDocument } from "../schema";
import type { CutEdge } from "../timeline/cut-point";
import type { Finding } from "./types";

type TrimArgs = { trimRangeId: string; startSec: number; endSec: number };

/** Builds `setTrim` fixes for cut edges; edges sharing one trim merge into the same operation. */
export function cutTrimFixes(document: AxcutDocument) {
	const fixes = new Map<string, TrimArgs>();
	return {
		fixFor(clipId: string, edge: CutEdge, timeSec: number, cutSec: number): Finding["fix"] {
			const trim = document.timeline.trimRanges.find(
				(item) =>
					item.clipId === clipId &&
					Math.abs((edge === "out" ? item.startSec : item.endSec) - timeSec) < 0.001,
			);
			if (!trim) return null;
			const args = fixes.get(trim.id) ?? {
				trimRangeId: trim.id,
				startSec: trim.startSec,
				endSec: trim.endSec,
			};
			if (edge === "out") args.startSec = cutSec;
			else args.endSec = cutSec;
			fixes.set(trim.id, args);
			return [{ type: "setTrim", args }];
		},
		dropInvalid(findings: Finding[]) {
			for (const item of findings) {
				const operation = item.fix?.[0];
				if (operation?.type === "setTrim" && operation.args.endSec <= operation.args.startSec)
					item.fix = null;
			}
		},
	};
}

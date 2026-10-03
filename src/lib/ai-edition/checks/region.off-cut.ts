import { isSubframeSpan } from "./frameSpan";
import { type CheckRule, finding } from "./types";

export const regionOffCut: CheckRule = {
	id: "region.off-cut",
	severity: "info",
	describe: "A region lies entirely in removed footage. Captions are excluded.",
	run(context) {
		return {
			findings: context.authored
				.filter(
					(region) =>
						region.kind !== "caption" && !isSubframeSpan(region.raw) && region.pieces.length === 0,
				)
				.map((region) =>
					finding(
						regionOffCut,
						{ startSec: region.at, endSec: region.at },
						region.clip,
						`${region.name} (${region.id}) has no kept footage; raw ${region.raw.startSec.toFixed(3)}–${region.raw.endSec.toFixed(3)}s.`,
					),
				),
		};
	},
};

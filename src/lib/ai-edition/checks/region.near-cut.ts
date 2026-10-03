import { isSubframeSpan } from "./frameSpan";
import { type CheckRule, finding } from "./types";

export const regionNearCut: CheckRule = {
	id: "region.near-cut",
	severity: "info",
	describe: "An authored region edge lies within 0.6 seconds of a cut. Captions are excluded.",
	run(context) {
		return {
			findings: context.authored
				.filter((region) => region.kind !== "caption" && !isSubframeSpan(region.raw))
				.flatMap((region) =>
					(["startSec", "endSec"] as const).flatMap((edge) => {
						const piece = region.pieces.find(
							(item) => Math.abs(item.raw[edge] - region.raw[edge]) < 0.001,
						);
						if (!piece || isSubframeSpan(piece.edited)) return [];
						const at = piece.edited[edge];
						const cut = context.cuts.reduce<number | null>(
							(nearest, candidate) =>
								nearest === null || Math.abs(candidate.at - at) < Math.abs(nearest - at)
									? candidate.at
									: nearest,
							null,
						);
						const distance = cut === null ? Infinity : Math.abs(cut - at);
						if (distance <= 0.001 || distance > 0.6 + 0.000001) return [];
						return [
							finding(
								regionNearCut,
								{ startSec: at, endSec: at },
								piece.clip,
								`${region.name} (${region.id}) ${edge === "startSec" ? "start" : "end"} is ${distance.toFixed(3)}s from a cut. Camera edges are snapped by the compositor since 2026-09-18.`,
							),
						];
					}),
				),
		};
	},
};

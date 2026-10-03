import { type CheckRule, finding } from "./types";

export const captionOrphaned: CheckRule = {
	id: "caption.orphaned",
	severity: "info",
	describe:
		"An automatic caption lies entirely in removed footage but references words kept in its owning clip. Captions without word provenance are skipped.",
	run(context) {
		return {
			findings: context.authored
				.filter((region) => {
					if (
						region.kind !== "caption" ||
						region.origin !== "auto" ||
						region.pieces.length ||
						!region.captionSource
					)
						return false;
					const source = region.captionSource;
					return (context.words.get(source.assetId) ?? []).some(
						(word) =>
							source.wordIds.includes(word.id) &&
							context.fragments.some(
								(fragment) =>
									source.clipIds.includes(fragment.clip) &&
									fragment.assetId === source.assetId &&
									word.startSec < fragment.source.endSec &&
									word.endSec > fragment.source.startSec,
							),
					);
				})
				.map((region) =>
					finding(
						captionOrphaned,
						{ startSec: region.at, endSec: region.at },
						region.clip,
						`Caption (${region.id}) has no kept footage, but its source words survive in its owning clip.`,
					),
				),
		};
	},
};

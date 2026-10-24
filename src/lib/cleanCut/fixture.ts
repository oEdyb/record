import { z } from "zod";
import type { CleanCutRegion, CleanCutSnapshot, CleanCutWord } from "./types";

const kindSchema = z.enum([
	"retake",
	"false-start",
	"repair",
	"stutter",
	"filler",
	"self-talk",
	"pause",
]);

/** The compact recorded session in `tests/fixtures/clean-cut-obs-session.json`. */
const fixtureSchema = z.object({
	rawDurationSec: z.number(),
	keep: z.array(z.tuple([z.number(), z.number()])),
	regions: z.array(
		z.tuple([
			kindSchema,
			z.number(),
			z.number(),
			z.number().nullable(),
			z.number().nullable(),
			z.string(),
			z.array(z.string()),
			z.boolean(),
		]),
	),
	words: z.array(z.tuple([z.string(), z.number(), z.number()])),
});

/** Builds a ready snapshot from the recorded session, mapped onto one recording. */
export function snapshotFromFixture(
	raw: unknown,
	assetId: string,
	projectId: string,
): CleanCutSnapshot {
	const fixture = fixtureSchema.parse(raw);
	const regionOfWord = new Map<number, string>();
	const regions: CleanCutRegion[] = fixture.regions.map(
		([kind, start, end, first, last, reason, sources, risky], index) => {
			const id = `cc-${index}`;
			const words: string[] = [];
			if (first !== null && last !== null) {
				for (let word = first; word <= last; word += 1) {
					regionOfWord.set(word, id);
					words.push(fixture.words[word]?.[0] ?? "");
				}
			}
			return {
				id,
				kind,
				assetId,
				removedStartSec: start,
				removedEndSec: end,
				words,
				reason,
				sources,
				risky,
			};
		},
	);
	const words: CleanCutWord[] = fixture.words.map(([text, startSec, endSec], index) => ({
		text,
		assetId,
		startSec,
		endSec,
		regionId: regionOfWord.get(index) ?? null,
	}));
	return {
		projectId,
		state: "ready",
		progress: 1,
		error: null,
		rawDurationSec: fixture.rawDurationSec,
		modelCheck: "done",
		keep: fixture.keep.map(([startSec, endSec]) => ({ assetId, startSec, endSec })),
		regions,
		words,
	};
}

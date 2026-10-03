import type { AxcutDocument, AxcutWord } from "../schema";
import type { CaptionCue } from "./cues";
import { deriveCaptionCues } from "./cues";
import { getCaptionSettings } from "./settings";
import { getCaptionTranslations } from "./translations";

/** Resolve against current derived cues; never trust stale positional word indexes. */
export function captionCorrectionWords(document: AxcutDocument, cueId: string): AxcutWord[] {
	const settings = getCaptionSettings(document);
	if (settings.language !== null) return [];
	const cue = deriveCaptionCues(document, settings, getCaptionTranslations(document)).find(
		(c) => c.id === cueId,
	);
	if (!cue?.source) return [];
	const words = document.transcripts.find((t) => t.assetId === cue.source!.assetId)?.words ?? [];
	const byId = new Map(words.map((word) => [word.id, word]));
	return cue.source.wordIds
		.map((id) => byId.get(id))
		.filter((word): word is AxcutWord => word !== undefined);
}

/** Correct source spelling, keeping all media and time coordinates intact. */
export function correctCaptionWords(
	document: AxcutDocument,
	cue: CaptionCue,
	replacements: Record<string, string>,
): AxcutDocument {
	const current = deriveCaptionCues(
		document,
		getCaptionSettings(document),
		getCaptionTranslations(document),
	).find((entry) => entry.id === cue.id);
	if (!current?.source || current.source.assetId !== cue.source?.assetId)
		throw new Error("invalid-correction");
	const words = captionCorrectionWords(document, cue.id);
	const allowed = new Map(words.map((word) => [word.id, word]));
	if (!cue.source || !words.length || !Object.keys(replacements).length)
		throw new Error("invalid-correction");
	for (const [id, text] of Object.entries(replacements)) {
		if (!allowed.has(id) || !text.trim() || /\s/u.test(text.trim()) || text.trim().length > 100)
			throw new Error("invalid-correction");
	}
	const changes = new Map(
		Object.entries(replacements)
			.filter(([id, text]) => allowed.get(id)?.text !== text.trim())
			.map(([id, text]) => [id, text.trim()]),
	);
	if (!changes.size) return document;
	const transcripts = document.transcripts.map((transcript) => {
		if (transcript.assetId !== cue.source!.assetId) return transcript;
		const corrected = transcript.words.map((word) =>
			changes.has(word.id) ? { ...word, text: changes.get(word.id)! } : word,
		);
		const byId = new Map(corrected.map((word) => [word.id, word]));
		return {
			...transcript,
			words: corrected,
			segments: transcript.segments.map((segment) =>
				segment.wordIds.some((id) => changes.has(id))
					? {
							...segment,
							text: segment.wordIds
								.map((id) => byId.get(id)?.text ?? "")
								.join(" ")
								.trim(),
						}
					: segment,
			),
		};
	});
	return {
		...document,
		transcripts,
		// Preserve the legacy primary transcript view when present.
		transcript:
			document.transcript?.assetId === cue.source.assetId
				? transcripts.find((t) => t.assetId === cue.source!.assetId)!
				: document.transcript,
	};
}

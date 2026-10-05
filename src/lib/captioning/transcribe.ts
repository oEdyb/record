/**
 * A timed caption unit. Existing projects store transcripts that the caption
 * renderer groups into these segments (see `ai-edition/captions/cues.ts`).
 * Transcription itself was archived at archive/pre-cleanup-2026-10-05.
 */
export interface CaptionSegment {
	/** Source transcript provenance retained through caption grouping and timing polish. */
	sourceWordIds?: string[];
	startSec: number;
	endSec: number;
	text: string;
}

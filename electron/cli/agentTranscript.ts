import type { AxcutClip, AxcutDocument, AxcutTranscript } from "../../src/lib/ai-edition/schema";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SEGMENTS = 400;
const MAX_GAPS = 500;

export interface AgentTranscriptOptions {
	clipId: string;
	offset?: number;
	limit?: number;
	minGapSec?: number;
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function findTranscript(document: AxcutDocument, assetId: string): AxcutTranscript | null {
	return (
		document.transcripts.find((t) => t.assetId === assetId) ??
		(document.transcript?.assetId === assetId ? document.transcript : null)
	);
}

function clipWindow(clip: AxcutClip) {
	return { start: clip.sourceStartSec, end: clip.sourceEndSec ?? Number.POSITIVE_INFINITY };
}

/** Source-time words, segments and silent gaps of one clip from the saved document. */
export function readAgentTranscript(document: AxcutDocument, options: AgentTranscriptOptions) {
	const clip = document.timeline.clips.find((c) => c.id === options.clipId);
	if (!clip) throw new Error("UNKNOWN_CLIP: No clip has that ID.");
	const asset = document.assets.find((a) => a.id === clip.assetId);
	const transcript = findTranscript(document, clip.assetId);
	const offset = options.offset ?? 0;
	const limit = options.limit ?? 200;
	const minGapSec = options.minGapSec ?? 0.5;
	const { start, end } = clipWindow(clip);
	const base = {
		clip: {
			id: clip.id,
			asset_id: clip.assetId,
			source_start: clip.sourceStartSec,
			source_end: clip.sourceEndSec ?? null,
			timeline_start: clip.timelineStartSec,
			timeline_end: clip.timelineEndSec,
		},
		time_base: "seconds in the source asset; use with addTrim, setClipRange and splitClip",
	};
	if (!transcript) {
		return {
			...base,
			transcript: {
				status: asset?.transcriptionFailure ? ("unavailable" as const) : ("not_stored" as const),
				failure: asset?.transcriptionFailure?.kind ?? null,
			},
			next_actions: [{ command: "klippt agent transcribe --project_id <id>" }],
		};
	}
	const words = transcript.words
		.filter((w) => w.endSec > start && w.startSec < end)
		.sort((a, b) => a.startSec - b.startSec);
	const segments = transcript.segments
		.filter((s) => s.endSec > start && s.startSec < end)
		.sort((a, b) => a.startSec - b.startSec);
	const gaps: { start: number; end: number; duration: number }[] = [];
	let cursor = start;
	for (const word of words) {
		if (word.startSec - cursor >= minGapSec)
			gaps.push({
				start: round(cursor),
				end: round(word.startSec),
				duration: round(word.startSec - cursor),
			});
		cursor = Math.max(cursor, word.endSec);
	}
	if (Number.isFinite(end) && end - cursor >= minGapSec)
		gaps.push({ start: round(cursor), end: round(end), duration: round(end - cursor) });
	const page = words.slice(offset, offset + limit);
	const result = {
		...base,
		transcript: {
			status: "stored" as const,
			language: transcript.language ?? null,
			word_count: words.length,
			segment_count: segments.length,
			speech_seconds: round(words.reduce((sum, w) => sum + (w.endSec - w.startSec), 0)),
		},
		words: page.map((w) => ({
			id: w.id,
			start: round(w.startSec),
			end: round(w.endSec),
			text: w.text,
		})),
		words_offset: offset,
		next_offset: offset + limit < words.length ? offset + limit : null,
		segments: segments.slice(0, MAX_SEGMENTS).map((s) => ({
			start: round(s.startSec),
			end: round(s.endSec),
			text: s.text.length > 400 ? `${s.text.slice(0, 400)}…` : s.text,
		})),
		segments_truncated: segments.length > MAX_SEGMENTS,
		gaps: gaps.slice(0, MAX_GAPS),
		gaps_truncated: gaps.length > MAX_GAPS,
		gap_rule: `silences of at least ${minGapSec}s between words, including lead-in and tail`,
	};
	if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES)
		throw new Error("INSPECTION_TOO_LARGE: Request fewer words with --limit.");
	return result;
}

export function readAllAgentTranscripts(document: AxcutDocument, page = 1) {
	const budget = 42 * 1024;
	type TimedText = {
		start: number;
		end: number;
		text: string;
		id?: string;
		part?: number;
		parts?: number;
	};
	type ClipPage = {
		id: string;
		name: string;
		name_truncated: boolean;
		status: string;
		words: TimedText[];
		sentences: TimedText[];
		words_offset: number;
		sentences_offset: number;
	};
	type Page = {
		clips: ClipPage[];
		missing: { id: string; name: string; name_truncated: boolean; status: string }[];
	};
	const pages: Page[] = [{ clips: [], missing: [] }];
	let current = pages[0];
	const newPage = () => {
		current = { clips: [], missing: [] };
		pages.push(current);
	};
	const fits = () => Buffer.byteLength(JSON.stringify(current)) <= budget;
	const splitText = (item: TimedText): TimedText[] => {
		const chars = Array.from(item.text);
		if (chars.length <= 2000) return [item];
		const parts = Math.ceil(chars.length / 2000);
		return Array.from({ length: parts }, (_, part) => ({
			...item,
			text: chars.slice(part * 2000, (part + 1) * 2000).join(""),
			part: part + 1,
			parts,
		}));
	};
	let missingCount = 0;
	for (const clip of document.timeline.clips) {
		const asset = document.assets.find((a) => a.id === clip.assetId);
		const transcript = findTranscript(document, clip.assetId);
		const fullName = asset?.label ?? clip.id;
		const name = fullName.slice(0, 512);
		const name_truncated = fullName.length > 512;
		const status = transcript
			? "stored"
			: asset?.transcriptionFailure
				? "unavailable"
				: "not_stored";
		const missing = { id: clip.id, name, name_truncated, status };
		if (!transcript) {
			missingCount++;
			current.missing.push(missing);
			if (!fits()) {
				current.missing.pop();
				newPage();
				current.missing.push(missing);
				if (!fits()) throw new Error("TRANSCRIPT_METADATA_TOO_LARGE");
			}
		}
		const { start, end } = clipWindow(clip);
		const words = (transcript?.words ?? [])
			.filter((w) => w.endSec > start && w.startSec < end)
			.sort((a, b) => a.startSec - b.startSec);
		const sentences: TimedText[] = [];
		let first = 0;
		words.forEach((word, i) => {
			const next = words[i + 1];
			if (!next || /[.!?]["'”’)]*$/.test(word.text.trim()) || next.startSec - word.endSec >= 0.8) {
				sentences.push({
					start: round(words[first].startSec),
					end: round(word.endSec),
					text: words
						.slice(first, i + 1)
						.map((w) => w.text)
						.join(" "),
				});
				first = i + 1;
			}
		});
		for (const segment of transcript?.segments ?? []) {
			if (segment.endSec <= start || segment.startSec >= end || segment.kind !== "speech") continue;
			if (words.some((word) => word.endSec > segment.startSec && word.startSec < segment.endSec))
				continue;
			sentences.push({
				start: round(segment.startSec),
				end: round(segment.endSec),
				text: segment.text,
			});
		}
		sentences.sort((a, b) => a.start - b.start);
		const rows = {
			words: words.flatMap((w) =>
				splitText({ id: w.id, start: round(w.startSec), end: round(w.endSec), text: w.text }),
			),
			sentences: sentences.flatMap(splitText),
		};
		const makeClip = (wordOffset: number, sentenceOffset: number): ClipPage => ({
			id: clip.id,
			name,
			name_truncated,
			status,
			words: [],
			sentences: [],
			words_offset: wordOffset,
			sentences_offset: sentenceOffset,
		});
		let row = makeClip(0, 0);
		current.clips.push(row);
		if (!fits()) {
			current.clips.pop();
			newPage();
			current.clips.push(row);
			if (!fits()) throw new Error("TRANSCRIPT_METADATA_TOO_LARGE");
		}
		let wordOffset = 0,
			sentenceOffset = 0;
		for (const kind of ["words", "sentences"] as const) {
			for (const item of rows[kind]) {
				row[kind].push(item);
				if (!fits()) {
					row[kind].pop();
					newPage();
					row = makeClip(wordOffset, sentenceOffset);
					current.clips.push(row);
					row[kind].push(item);
					if (!fits()) throw new Error("TRANSCRIPT_ITEM_TOO_LARGE");
				}
				if (kind === "words") wordOffset++;
				else sentenceOffset++;
			}
		}
	}
	if (page < 1 || page > pages.length) throw new Error(`INVALID_PAGE: Use 1..${pages.length}.`);
	return {
		source: "saved_project",
		time_base: "source seconds",
		total_clips: document.timeline.clips.length,
		missing_count: missingCount,
		page,
		pages: pages.length,
		next_page: page < pages.length ? page + 1 : null,
		...pages[page - 1],
		sentence_rule:
			"Sentence punctuation or a source gap of at least 0.8 seconds; derived from stored words, with stored speech segments as fallback where word timing is absent.",
		next_actions: missingCount
			? [{ command: `klippt agent transcribe --project_id ${document.project.id}` }]
			: [],
	};
}

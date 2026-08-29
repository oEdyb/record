import type {
	SttSourceRole,
	SttTranscribeSourceRequest,
	SttTranscribeSourceResponse,
} from "../../../../electron/stt/transcriptionContract";
import { phrasesWithoutTimedWords } from "../../captioning/transcribe";
import type { AxcutDocument, AxcutTranscript, AxcutTranscriptSegment, AxcutWord } from "../schema";

/**
 * What the caller can show while a transcription runs. `completedSec` /
 * `totalSec` arrive only during `"transcribing"`, once the main process starts
 * landing chunks — until then the phase alone is all there is to show.
 */
export interface TranscribeStatus {
	phase: "extracting-audio" | "loading-model" | "transcribing";
	completedSec?: number;
	totalSec?: number;
}

export interface TranscribeAssetOptions {
	language?: string;
	onStatus?: (status: TranscribeStatus) => void;
	signal?: AbortSignal;
}

interface SourceSttApi {
	transcribeSource: (request: SttTranscribeSourceRequest) => Promise<SttTranscribeSourceResponse>;
	cancel?: () => Promise<void>;
	onStatus?: (
		callback: (event: {
			phase: "model" | "transcribe";
			completedSec?: number;
			totalSec?: number;
		}) => void,
	) => () => void;
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function stableTimedId(
	prefix: "seg" | "word",
	role: SttSourceRole,
	startSec: number,
	endSec: number,
	text: string,
): string {
	return `${prefix}_${role.replace("unknown-mixed", "mixed")}_${Math.round(startSec * 1_000)}_${Math.round(
		endSec * 1_000,
	)}_${stableHash(text)}`;
}

function transcriptContent(result: SttTranscribeSourceResponse): {
	segments: AxcutTranscriptSegment[];
	words: AxcutWord[];
} {
	const rolePriority: Record<SttSourceRole, number> = {
		you: 0,
		system: 1,
		"unknown-mixed": 2,
	};
	const sourceWords = [
		...result.wordSegments,
		...phrasesWithoutTimedWords(result).flatMap((segment) => {
			const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
			const duration = Math.max(0, segment.endSec - segment.startSec);
			return tokens.map((word, index) => ({
				word,
				startSec: segment.startSec + (duration * index) / Math.max(1, tokens.length),
				endSec: segment.startSec + (duration * (index + 1)) / Math.max(1, tokens.length),
				sourceRole: segment.sourceRole,
				confidence: undefined,
			}));
		}),
	];
	const ordered = [...sourceWords].sort(
		(a, b) =>
			a.startSec - b.startSec ||
			rolePriority[a.sourceRole ?? "unknown-mixed"] -
				rolePriority[b.sourceRole ?? "unknown-mixed"] ||
			a.endSec - b.endSec,
	);

	const groups: Array<{
		role: SttSourceRole;
		startSec: number;
		endSec: number;
		items: typeof ordered;
	}> = [];
	for (const item of ordered) {
		const role = item.sourceRole ?? "unknown-mixed";
		const previous = groups.at(-1);
		if (
			!previous ||
			previous.role !== role ||
			item.startSec - previous.endSec > 0.8 ||
			item.endSec - previous.startSec > 15
		) {
			groups.push({
				role,
				startSec: item.startSec,
				endSec: item.endSec,
				items: [item],
			});
		} else {
			previous.items.push(item);
			previous.endSec = Math.max(previous.endSec, item.endSec);
		}
	}

	const words: AxcutWord[] = [];
	const segments: AxcutTranscriptSegment[] = [];
	const usedIds = new Map<string, number>();
	const uniqueId = (base: string) => {
		const occurrence = usedIds.get(base) ?? 0;
		usedIds.set(base, occurrence + 1);
		return occurrence === 0 ? base : `${base}_${occurrence + 1}`;
	};
	for (const group of groups) {
		const text = group.items.map((item) => item.word).join(" ");
		const segmentId = uniqueId(
			stableTimedId("seg", group.role, group.startSec, group.endSec, text),
		);
		const wordIds = group.items.map((item) => {
			const wordId = uniqueId(
				stableTimedId("word", group.role, item.startSec, item.endSec, item.word),
			);
			words.push({
				id: wordId,
				segmentId,
				startSec: item.startSec,
				endSec: item.endSec,
				text: item.word,
				sourceRole: group.role,
				confidence: item.confidence,
			});
			return wordId;
		});
		segments.push({
			id: segmentId,
			kind: "speech",
			startSec: group.startSec,
			endSec: group.endSec,
			text,
			wordIds,
			sourceRole: group.role,
		});
	}
	return { segments, words };
}

export async function transcribeAsset(
	document: AxcutDocument,
	assetId: string,
	options: TranscribeAssetOptions = {},
): Promise<AxcutTranscript> {
	if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const asset = document.assets.find((a) => a.id === assetId);
	if (!asset) {
		throw new Error(`Asset ${assetId} not found in document.`);
	}

	const api = (window as Window & { electronAPI?: { stt?: SourceSttApi } }).electronAPI?.stt;
	if (!api?.transcribeSource) {
		throw new Error("Local source transcription is unavailable.");
	}
	options.onStatus?.({ phase: "extracting-audio" });
	const unsubscribe = api.onStatus?.((status) =>
		options.onStatus?.({
			phase: status.phase === "model" ? "loading-model" : "transcribing",
			completedSec: status.completedSec,
			totalSec: status.totalSec,
		}),
	);
	const onAbort = () => void api.cancel?.();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	let result: SttTranscribeSourceResponse;
	try {
		if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		result = await api.transcribeSource({
			sourcePath: asset.originalPath,
			sourceKind: asset.recordingImportId ? "klippt-recording" : "import",
			durationSec: asset.durationSec,
			language: options.language && options.language !== "auto" ? options.language : undefined,
		});
		if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
	} catch (error) {
		if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		unsubscribe?.();
	}
	const { segments, words } = transcriptContent(result);

	return {
		assetId,
		// Prefer the model-reported language (covers both forced picks and
		// auto-detect); fall back to the input option, then "auto" when
		// nothing was detected (very rare on tiny.en — usually a no-audio run).
		language: result.detectedLanguage ?? options.language ?? "auto",
		segments,
		words,
		evidenceStatus: "verified",
		sources: result.sources,
	};
}

// ponytail: emit the upstream `AXCUT_TRANSCRIPT v1` plain-text DSL for display
// in the Source Transcript modal. Mirrors `axcut_core/dsl.py` just enough for
// the modal's <pre> body — a small segment/word loop, no Python needed. The
// runtime still uses the structured `AxcutTranscript`; this string is the
// "what the user reads" view of the same data.
// Escape both single and double quotes — the DSL wraps every string in
// double quotes and uses SQL/Python-style `''` doubling for an embedded
// single quote.
function escapeDslString(s: string): string {
	return s.replace(/"/g, '""').replace(/'/g, "''");
}

export function toAxcutTranscriptDsl(
	transcript: AxcutTranscript,
	sourceLabel?: string,
	durationSec?: number,
): string {
	const lines: string[] = ["AXCUT_TRANSCRIPT v1"];
	const meta: string[] = [];
	if (sourceLabel) meta.push(`source_video="${sourceLabel}"`);
	if (typeof durationSec === "number" && Number.isFinite(durationSec)) {
		meta.push(`duration=${durationSec.toFixed(3)}`);
	}
	meta.push(`language="${transcript.language || "auto"}"`, `kind="source"`);
	lines.push(`META ${meta.join(" ")}`);

	const segIndexById = new Map<string, number>();
	transcript.segments.forEach((seg, i) => segIndexById.set(seg.id, i + 1));

	for (const seg of transcript.segments) {
		lines.push(
			`SEGMENT id=s${String(segIndexById.get(seg.id) ?? 0).padStart(4, "0")} start=${seg.startSec.toFixed(3)} end=${seg.endSec.toFixed(3)} text="${escapeDslString(seg.text)}"`,
		);
		for (const wordId of seg.wordIds) {
			const word = transcript.words.find((w) => w.id === wordId);
			if (!word) continue;
			const wSegIdx = segIndexById.get(word.segmentId) ?? 0;
			lines.push(
				`WORD id=w${String(transcript.words.indexOf(word) + 1).padStart(6, "0")} segment=s${String(wSegIdx).padStart(4, "0")} start=${word.startSec.toFixed(3)} end=${word.endSec.toFixed(3)} text="${escapeDslString(word.text)}"`,
			);
		}
		lines.push("ENDSEGMENT");
	}
	return lines.join("\n");
}

export function withTranscript(
	document: AxcutDocument,
	transcript: AxcutTranscript,
): AxcutDocument {
	const transcripts = [
		...document.transcripts.filter((t) => t.assetId !== transcript.assetId),
		transcript,
	];
	return {
		...document,
		transcript:
			document.project.primaryAssetId === transcript.assetId ? transcript : document.transcript,
		transcripts,
	};
}

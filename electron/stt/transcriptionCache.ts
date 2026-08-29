import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { hasCompletePhraseWordTiming } from "./seamMerge";
import type {
	SttBackend,
	SttPhraseSegment,
	SttSourceEvidence,
	SttSourceRole,
	SttWordSegment,
} from "./transcriptionContract";

const CACHE_VERSION = 1 as const;

export interface TranscriptCacheIdentity {
	version: typeof CACHE_VERSION;
	sourceContentSha256: string;
	sourceDurationSec: number;
	sourceRole: SttSourceRole;
	backend: SttBackend;
	model: SttSourceEvidence["model"];
	requestedLanguage: string;
	extractionVersion: number;
	chunkingVersion: number;
	seamVersion: number;
	alignmentVersion: number;
	vocabularySha256: string;
}

export interface CachedSourceTranscript {
	segments: SttPhraseSegment[];
	wordSegments: SttWordSegment[];
	detectedLanguage: string;
	backend: SttBackend;
	processedSec: number;
}

interface CacheEnvelope {
	version: typeof CACHE_VERSION;
	identity: TranscriptCacheIdentity;
	result: CachedSourceTranscript;
}

function stableIdentity(identity: TranscriptCacheIdentity): string {
	return JSON.stringify({
		version: identity.version,
		sourceContentSha256: identity.sourceContentSha256,
		sourceDurationSec: identity.sourceDurationSec,
		sourceRole: identity.sourceRole,
		backend: identity.backend,
		model: {
			id: identity.model.id,
			revision: identity.model.revision,
			artifactSha256: [...identity.model.artifactSha256],
		},
		requestedLanguage: identity.requestedLanguage,
		extractionVersion: identity.extractionVersion,
		chunkingVersion: identity.chunkingVersion,
		seamVersion: identity.seamVersion,
		alignmentVersion: identity.alignmentVersion,
		vocabularySha256: identity.vocabularySha256,
	});
}

export function transcriptCacheKey(identity: TranscriptCacheIdentity): string {
	return createHash("sha256").update(stableIdentity(identity)).digest("hex");
}

function isFiniteTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validSegment(
	value: unknown,
	role: SttSourceRole,
	sourceDurationSec: number,
): value is SttPhraseSegment {
	if (!value || typeof value !== "object") return false;
	const segment = value as Partial<SttPhraseSegment>;
	return (
		typeof segment.text === "string" &&
		isFiniteTime(segment.startSec) &&
		isFiniteTime(segment.endSec) &&
		segment.endSec >= segment.startSec &&
		segment.endSec <= sourceDurationSec + 0.5 &&
		segment.sourceRole === role
	);
}

function validWord(
	value: unknown,
	role: SttSourceRole,
	sourceDurationSec: number,
): value is SttWordSegment {
	if (!value || typeof value !== "object") return false;
	const word = value as Partial<SttWordSegment>;
	return (
		typeof word.word === "string" &&
		word.word.trim().length > 0 &&
		isFiniteTime(word.startSec) &&
		isFiniteTime(word.endSec) &&
		word.endSec >= word.startSec &&
		word.endSec <= sourceDurationSec + 0.5 &&
		word.sourceRole === role &&
		(word.confidence === undefined ||
			(typeof word.confidence === "number" &&
				Number.isFinite(word.confidence) &&
				word.confidence >= 0 &&
				word.confidence <= 1))
	);
}

function parseEnvelope(value: unknown, identity: TranscriptCacheIdentity): CacheEnvelope | null {
	if (!value || typeof value !== "object") return null;
	const envelope = value as Partial<CacheEnvelope>;
	if (
		envelope.version !== CACHE_VERSION ||
		!envelope.identity ||
		stableIdentity(envelope.identity) !== stableIdentity(identity) ||
		!envelope.result ||
		!isFiniteTime(identity.sourceDurationSec) ||
		identity.sourceDurationSec <= 0
	) {
		return null;
	}
	const result = envelope.result;
	if (
		!Array.isArray(result.segments) ||
		!result.segments.every((segment) =>
			validSegment(segment, identity.sourceRole, identity.sourceDurationSec),
		) ||
		!Array.isArray(result.wordSegments) ||
		!result.wordSegments.every((word) =>
			validWord(word, identity.sourceRole, identity.sourceDurationSec),
		) ||
		!hasCompletePhraseWordTiming(result.segments, result.wordSegments) ||
		typeof result.detectedLanguage !== "string" ||
		result.detectedLanguage.length === 0 ||
		result.backend !== identity.backend ||
		!isFiniteTime(result.processedSec) ||
		Math.abs(result.processedSec - identity.sourceDurationSec) > 0.1
	) {
		return null;
	}
	return envelope as CacheEnvelope;
}

export class TranscriptCache {
	constructor(private readonly baseDir: string) {}

	private filePath(identity: TranscriptCacheIdentity): string {
		return path.join(this.baseDir, `${transcriptCacheKey(identity)}.json`);
	}

	async read(
		identity: TranscriptCacheIdentity,
		signal?: AbortSignal,
	): Promise<CachedSourceTranscript | null> {
		if (signal?.aborted) throw signal.reason;
		try {
			const text = await readFile(this.filePath(identity), { encoding: "utf8", signal });
			return parseEnvelope(JSON.parse(text), identity)?.result ?? null;
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || error instanceof SyntaxError) {
				return null;
			}
			return null;
		}
	}

	async write(
		identity: TranscriptCacheIdentity,
		result: CachedSourceTranscript,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) throw signal.reason;
		const envelope: CacheEnvelope = { version: CACHE_VERSION, identity, result };
		if (!parseEnvelope(envelope, identity)) {
			throw new Error("Refusing to cache an invalid source transcript.");
		}
		await mkdir(this.baseDir, { recursive: true });
		const destination = this.filePath(identity);
		const partial = `${destination}.${process.pid}.${randomUUID()}.partial`;
		try {
			await writeFile(partial, JSON.stringify(envelope), { encoding: "utf8", flag: "wx", signal });
			if (signal?.aborted) throw signal.reason;
			await rename(partial, destination);
		} finally {
			await rm(partial, { force: true }).catch(() => undefined);
		}
	}
}

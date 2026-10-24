export interface SpokenWord {
	word: string;
	startSec: number;
	endSec: number;
	confidence: number;
}

export interface WordTime {
	startSec: number;
	endSec: number;
}

export interface CleanCutTake {
	id: string;
	folder: string;
	key: string;
	recordedAtMs: number;
	/** Mono PCM at 16 kHz. */
	pcm: Float32Array;
	/** Parakeet words. Every decision is made on these times. */
	words: SpokenWord[];
	/** Forced-aligned times, one per word. Used only to place cuts. */
	alignedTimes?: WordTime[];
}

export interface DecisionModel {
	ask(prompt: string, label: string): Promise<string>;
}

export interface HesitationVetter {
	/** Words the recognizer reads in a short window of 16 kHz mono PCM. */
	read(window: Float32Array): Promise<string[]>;
}

export type FillerPolicy = "paused" | "all" | "none";

export interface CleanCutOptions {
	fillers?: FillerPolicy;
	pauseMaxSec?: number;
	listenFirstLimit?: number;
}

export interface CleanCutInput {
	takes: CleanCutTake[];
	model?: DecisionModel | null;
	vetter?: HesitationVetter | null;
	options?: CleanCutOptions;
}

export type DecisionSource = "rule" | "model" | "session";

export interface KeptClip {
	startSec: number;
	endSec: number;
	firstWordIndex: number;
	lastWordIndex: number;
	words: string[];
	joinReasons: string[];
	startKind: string;
	endKind: string;
}

export interface TakePlan {
	takeId: string;
	clips: KeptClip[];
}

export interface DroppedWord {
	takeId: string;
	wordIndex: number;
	word: string;
	startSec: number;
	endSec: number;
	kind: string;
	reason: string;
	sources: DecisionSource[];
}

export interface CutRegion {
	takeId: string;
	firstWordIndex: number;
	lastWordIndex: number;
	text: string;
	startSec: number;
	endSec: number;
	kind: string;
	reason: string;
	sources: DecisionSource[];
	/** Where this cut plays in the clean timeline; null when it falls after the last clip. */
	timelineSec: number | null;
	keptTimelineSec: number | null;
	risky: boolean;
	riskScore: number;
	riskFlags: string[];
}

export interface CleanCutStats {
	takes: number;
	words: number;
	droppedWords: number;
	cuts: number;
	clips: number;
	joins: number;
	compressedPauses: number;
	hesitationCandidates: number;
	hesitationsConfirmed: number;
	hesitationsCut: number;
	sessionOnlyWords: number;
	silenceSavedSec: number;
	edgeSilenceTrimmedSec: number;
	spokenSec: number;
	cleanTimelineSec: number;
}

export interface CleanCutPlan {
	takes: TakePlan[];
	dropped: DroppedWord[];
	cuts: CutRegion[];
	stats: CleanCutStats;
	skipped: string[];
}

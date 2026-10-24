/** How much the clean cut removes. Gentle keeps only word cuts two or more checks agree on. */
export type CleanCutStrength = "gentle" | "clean";

export type CleanCutState = "off" | "working" | "ready" | "failed";

export type CleanCutKind =
	| "retake"
	| "false-start"
	| "repair"
	| "stutter"
	| "filler"
	| "self-talk"
	| "pause"
	/** A sentence the viewer cut themself. */
	| "manual";

/** A stretch the clean cut keeps, in its recording's source seconds. */
export interface CleanCutKeep {
	assetId: string;
	startSec: number;
	endSec: number;
}

/** One suggested cut: the source range it removes and why. */
export interface CleanCutRegion {
	id: string;
	kind: CleanCutKind;
	assetId: string;
	removedStartSec: number;
	removedEndSec: number;
	words: string[];
	reason: string;
	/** The checks that flagged this cut, e.g. "rule", "model", "session". */
	sources: string[];
	/** The engine is unsure; review lists these first. */
	risky: boolean;
}

export interface CleanCutWord {
	text: string;
	assetId: string;
	startSec: number;
	endSec: number;
	regionId: string | null;
}

export type CleanCutModelCheck = "done" | "unavailable" | "failed";

export interface CleanCutSnapshot {
	/** The project this analysis belongs to; snapshots for another project are ignored. */
	projectId: string | null;
	state: CleanCutState;
	/** 0 to 1 while working, null when unknown. */
	progress: number | null;
	error: string | null;
	rawDurationSec: number | null;
	/** Whether Claude checked the cut. "unavailable" or "failed" means a rules-only cut that finds less. */
	modelCheck: CleanCutModelCheck | null;
	/** Kept stretches in edit order, with every region cut. */
	keep: CleanCutKeep[];
	regions: CleanCutRegion[];
	words: CleanCutWord[];
}

export type CleanCutMarkerColor =
	| "RED"
	| "ORANGE"
	| "YELLOW"
	| "GREEN"
	| "CYAN"
	| "BLUE"
	| "PURPLE"
	| "PINK";

/** A marker at the start of kept stretch `keepIndex`, right after the cut it explains. */
export interface CleanCutMarker {
	keepIndex: number;
	name: string;
	comment: string;
	color: CleanCutMarkerColor;
}

/** What Save hands to the source export; matches `electron/export/cleanCutSpans.ts`. */
export interface CleanCutExport {
	keep: CleanCutKeep[];
	markers: CleanCutMarker[];
}

/**
 * The main-process clean cut service as the renderer sees it. `start` carries a clone of the
 * project document, as `exportSources` does, and returns once the request is accepted;
 * progress and results arrive through `onSnapshot`. Strength is a hint: review filters
 * Gentle itself from each region's `sources`, so the snapshot must always carry every Clean
 * region.
 */
export interface CleanCutBridge {
	start: (projectId: string, strength: CleanCutStrength, document: unknown) => Promise<void>;
	cancel: () => Promise<void>;
	onSnapshot: (callback: (snapshot: CleanCutSnapshot) => void) => () => void;
}

export const EMPTY_CLEAN_CUT_SNAPSHOT: CleanCutSnapshot = {
	projectId: null,
	state: "off",
	progress: null,
	error: null,
	rawDurationSec: null,
	modelCheck: null,
	keep: [],
	regions: [],
	words: [],
};

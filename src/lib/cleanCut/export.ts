import { activeRegions, effectiveKeep } from "./keep";
import type {
	CleanCutExport,
	CleanCutKeep,
	CleanCutKind,
	CleanCutMarker,
	CleanCutMarkerColor,
	CleanCutRegion,
	CleanCutStrength,
} from "./types";

const JOIN_EPSILON_SEC = 0.001;
const COMMENT_WORDS = 18;
/** Resolve shows a marker note in one field; the main process accepts up to 500 characters. */
export const MAX_MARKER_TEXT = 500;

function clip(text: string) {
	return text.length <= MAX_MARKER_TEXT ? text : `${text.slice(0, MAX_MARKER_TEXT - 1)}…`;
}

/**
 * Marker names and colors for the editor timeline; one color per reason. Only colors
 * DaVinci Resolve has: it shows an unknown color, such as orange, as green.
 */
export const CLEAN_CUT_MARKER_STYLE: Record<
	Exclude<CleanCutKind, "pause">,
	{ name: string; color: CleanCutMarkerColor }
> = {
	retake: { name: "Retake", color: "RED" },
	"false-start": { name: "False start", color: "YELLOW" },
	repair: { name: "Repair", color: "PURPLE" },
	stutter: { name: "Stutter", color: "CYAN" },
	filler: { name: "Filler", color: "GREEN" },
	"self-talk": { name: "Self-talk", color: "PINK" },
};

function quote(words: readonly string[]) {
	const shown = words.slice(0, COMMENT_WORDS).join(" ");
	return words.length > COMMENT_WORDS ? `${shown}…` : shown;
}

/** Index of the stretch that plays right after a cut, or -1 when the cut ends the video. */
function keepIndexAfter(keep: readonly CleanCutKeep[], region: CleanCutRegion) {
	let best = -1;
	keep.forEach((entry, index) => {
		if (entry.assetId !== region.assetId) return;
		if (entry.startSec < region.removedEndSec - JOIN_EPSILON_SEC) return;
		if (best === -1 || entry.startSec < keep[best].startSec) best = index;
	});
	return best;
}

/**
 * What Save exports for the clean cut: the kept stretches at this strength and with these
 * restores, and one marker per remaining word cut, on the stretch right after it. Pauses
 * get no marker; cuts that land on the same stretch share one.
 */
export function toCleanCut(
	keep: readonly CleanCutKeep[],
	regions: readonly CleanCutRegion[],
	strength: CleanCutStrength,
	restored: ReadonlySet<string>,
): CleanCutExport {
	const kept = effectiveKeep(keep, regions, strength, restored);
	const byStretch = new Map<number, CleanCutRegion[]>();
	for (const region of activeRegions(regions, strength, restored)) {
		if (region.kind === "pause") continue;
		const index = keepIndexAfter(kept, region);
		if (index === -1) continue;
		byStretch.set(index, [...(byStretch.get(index) ?? []), region]);
	}
	const markers: CleanCutMarker[] = [...byStretch.entries()]
		.sort(([a], [b]) => a - b)
		.map(([keepIndex, cuts]) => {
			const styles = cuts.map((cut) =>
				cut.kind === "pause" ? null : CLEAN_CUT_MARKER_STYLE[cut.kind],
			);
			const names = [...new Set(styles.map((style) => style?.name).filter(Boolean))];
			return {
				keepIndex,
				name: clip(names.join(" + ")),
				comment: clip(
					cuts
						.map((cut) => {
							const label = cut.kind === "pause" ? cut.kind : CLEAN_CUT_MARKER_STYLE[cut.kind].name;
							const said = cut.words.length ? `: “${quote(cut.words)}”` : "";
							return `${label}${cut.reason ? ` (${cut.reason})` : ""}${said}`;
						})
						.join(" / "),
				),
				color: styles[0]?.color ?? "BLUE",
			};
		});
	return { keep: kept, markers };
}

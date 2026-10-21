import type { CleanCutKind } from "@/lib/cleanCut/types";

const KIND_KEY: Record<CleanCutKind, string> = {
	retake: "cleanCut.kind.retake",
	"false-start": "cleanCut.kind.falseStart",
	repair: "cleanCut.kind.repair",
	stutter: "cleanCut.kind.stutter",
	filler: "cleanCut.kind.filler",
	"self-talk": "cleanCut.kind.selfTalk",
	pause: "cleanCut.kind.pause",
};

export function cleanCutKindKey(kind: CleanCutKind): string {
	return KIND_KEY[kind];
}

/** Removed time as the list shows it: tenths under ten seconds, then whole seconds, then m:ss. */
export function formatRemoved(sec: number): string {
	const safe = Math.max(0, sec);
	if (safe < 10) return `−${safe.toFixed(1)} s`;
	if (safe < 60) return `−${Math.round(safe)} s`;
	const whole = Math.round(safe);
	return `−${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Signed runtime change, e.g. "−9:06". */
export function formatSaved(sec: number): string {
	const whole = Math.round(Math.abs(sec));
	const sign = sec > 0.5 ? "−" : "";
	return `${sign}${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

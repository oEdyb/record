import { create } from "zustand";
import type { CaptionCue } from "../captions";
import type { AxcutDocument } from "../schema";

/** Selection belongs to one immutable document snapshot. Edits and Undo invalidate it. */
export const useCaptionSelectionStore = create<{
	selection: { document: AxcutDocument | null; cue: CaptionCue; token: number } | null;
	select: (document: AxcutDocument | null, cue: CaptionCue) => void;
}>((set) => ({
	selection: null,
	select: (document, cue) =>
		set((state) => ({ selection: { document, cue, token: (state.selection?.token ?? 0) + 1 } })),
}));

import { create } from "zustand";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";

/** Listening level for the editor preview only. Export audio never reads it. */
export interface PreviewAudioState {
	volume: number;
	muted: boolean;
	setVolume: (volume: number) => void;
	toggleMuted: () => void;
}

const clampVolume = (volume: number) =>
	Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;

export const usePreviewAudio = create<PreviewAudioState>((set, get) => {
	const prefs = loadUserPreferences();
	return {
		volume: clampVolume(prefs.previewVolume),
		muted: prefs.previewMuted,
		setVolume: (volume) => {
			const next = clampVolume(volume);
			set({ volume: next, muted: next === 0 ? get().muted : false });
			saveUserPreferences({ previewVolume: next, previewMuted: get().muted });
		},
		toggleMuted: () => {
			const muted = !get().muted;
			set({ muted });
			saveUserPreferences({ previewMuted: muted });
		},
	};
});

/** Push the preview level onto one media element; `forceMuted` wins for elements that must stay silent. */
export function applyPreviewAudio(
	element: HTMLMediaElement | null,
	state: Pick<PreviewAudioState, "volume" | "muted">,
	forceMuted = false,
): void {
	if (!element) return;
	if (element.volume !== state.volume) element.volume = state.volume;
	const muted = forceMuted || state.muted;
	if (element.muted !== muted) element.muted = muted;
}

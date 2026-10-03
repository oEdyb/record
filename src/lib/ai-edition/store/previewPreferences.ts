import { create } from "zustand";

export type PreviewQuality = "sharp" | "performance";
export const PREVIEW_QUALITY_KEY = "klippt-preview-quality-v1";

export function readPreviewQuality(): PreviewQuality {
	try {
		return localStorage.getItem(PREVIEW_QUALITY_KEY) === "performance" ? "performance" : "sharp";
	} catch {
		return "sharp";
	}
}

// A viewing preference belongs to this device, not the document or export settings.
export const usePreviewPreferences = create<{
	quality: PreviewQuality;
	setQuality: (quality: PreviewQuality) => void;
}>((set) => ({
	quality: readPreviewQuality(),
	setQuality: (quality) => {
		if (quality !== "sharp" && quality !== "performance") return;
		try {
			localStorage.setItem(PREVIEW_QUALITY_KEY, quality);
		} catch {
			// Continue using the choice for this session if storage is unavailable.
		}
		set({ quality });
	},
}));

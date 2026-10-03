// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadUserPreferences } from "@/lib/userPreferences";
import { applyPreviewAudio, usePreviewAudio } from "./previewAudio";

describe("preview audio level", () => {
	beforeEach(() => {
		localStorage.clear();
		usePreviewAudio.setState({ volume: 1, muted: false });
	});

	it("remembers the level and the mute as a user preference", () => {
		usePreviewAudio.getState().setVolume(0.3);
		usePreviewAudio.getState().toggleMuted();
		expect(loadUserPreferences()).toMatchObject({ previewVolume: 0.3, previewMuted: true });
	});

	it("moving the slider while muted unmutes, unless it lands on zero", () => {
		usePreviewAudio.getState().toggleMuted();
		usePreviewAudio.getState().setVolume(0);
		expect(usePreviewAudio.getState().muted).toBe(true);
		usePreviewAudio.getState().setVolume(0.5);
		expect(usePreviewAudio.getState()).toMatchObject({ volume: 0.5, muted: false });
	});

	it("keeps an element silent when the caller forces it, whatever the level", () => {
		const element = document.createElement("video");
		applyPreviewAudio(element, { volume: 0.4, muted: false }, true);
		expect(element.muted).toBe(true);
		expect(element.volume).toBe(0.4);
		applyPreviewAudio(element, { volume: 0.4, muted: false });
		expect(element.muted).toBe(false);
	});
});

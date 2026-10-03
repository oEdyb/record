import { describe, expect, it } from "vitest";
import { getCaptionSettings, patchCaptionSettings } from "../captions/settings";
import { createEmptyDocument } from "../schema";
import { getEditorSettings, patchEditorSettings } from "./editorSettings";
import {
	applyVisualPreset,
	BUILTIN_VISUAL_PRESETS,
	captureVisualPreset,
	loadVisualPresets,
	saveVisualPresets,
} from "./visualPresets";

const document = () => createEmptyDocument({ projectId: "preset-test", title: "Presets" });
function storage() {
	let value: string | null = null;
	return {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
	};
}
describe("visual presets", () => {
	it("applies presentation without replacing content, canvas, camera framing or audio", () => {
		const original = patchCaptionSettings(
			patchEditorSettings(document(), {
				aspectRatio: "9:16",
				webcamSizePreset: 65,
				webcamMirrored: true,
				webcamPosition: { cx: 0.12, cy: 0.2 },
				microphoneMuted: true,
			}),
			{ enabled: true, language: "sv" },
		);
		const next = applyVisualPreset(original, BUILTIN_VISUAL_PRESETS[0]);
		expect(next.timeline).toBe(original.timeline);
		expect(next.transcripts).toBe(original.transcripts);
		expect(next.assets).toBe(original.assets);
		expect(getEditorSettings(next)).toMatchObject({
			aspectRatio: "9:16",
			webcamSizePreset: 65,
			webcamMirrored: true,
			webcamPosition: { cx: 0.12, cy: 0.2 },
			microphoneMuted: true,
			wallpaper: "#20252e",
			webcamMaskShape: "squircle",
		});
		expect(getCaptionSettings(next)).toMatchObject({
			enabled: true,
			language: "sv",
			fontFamily: "Geist",
		});
		expect(getEditorSettings(original).wallpaper).not.toBe("#20252e");
	});
	it("round trips a named appearance and strips unowned fields", () => {
		const saved = captureVisualPreset(document(), " My style ", "local-1");
		const memory = storage();
		saveVisualPresets([saved], memory);
		expect(loadVisualPresets(memory)).toEqual([{ ...saved, name: "My style" }]);
		expect(saved.appearance.frame).not.toHaveProperty("cropRegion");
		expect(saved.appearance.captions).not.toHaveProperty("enabled");
		expect(saved.appearance.captions).not.toHaveProperty("language");
	});
	it("rejects source-specific background references instead of silently changing the style", () => {
		expect(() =>
			captureVisualPreset(
				patchEditorSettings(document(), { wallpaper: "data:image/png;base64,test" }),
				"Image",
				"id",
			),
		).toThrow();
	});
	it("does not apply unknown fields smuggled through preset storage", () => {
		const preset = BUILTIN_VISUAL_PRESETS[0];
		const original = document();
		const next = applyVisualPreset(original, {
			...preset,
			appearance: {
				...preset.appearance,
				frame: { ...preset.appearance.frame, microphoneMuted: true },
			},
		} as typeof preset);
		expect(getEditorSettings(next).microphoneMuted).toBe(false);
	});
	it("bounds the library and rejects duplicate names and corrupt storage", () => {
		const memory = storage();
		memory.setItem("ignored", "{");
		expect(loadVisualPresets(memory)).toEqual([]);
		const a = captureVisualPreset(document(), "Look", "1");
		expect(() => saveVisualPresets([a, { ...a, id: "2", name: "LOOK" }], memory)).toThrow();
		expect(() =>
			saveVisualPresets(
				Array.from({ length: 21 }, (_, i) => ({ ...a, id: String(i), name: String(i) })),
				memory,
			),
		).toThrow();
	});
});

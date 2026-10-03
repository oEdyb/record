import { z } from "zod";
import { WALLPAPER_PATHS } from "@/lib/wallpaper";
import { getCaptionSettings, patchCaptionSettings } from "../captions/settings";
import type { AxcutDocument } from "../schema";
import { getEditorSettings, patchEditorSettings } from "./editorSettings";

const color = z.string().regex(/^#[\da-f]{3}(?:[\da-f]{3})?$/i);
// Presets contain reusable presentation only. Never carry source crops, media,
// translations, canvas dimensions, audio settings or timeline content.
const frameSchema = z.object({
	wallpaper: z
		.string()
		.max(2048)
		.refine(
			(value) =>
				WALLPAPER_PATHS.includes(value) ||
				color.safeParse(value).success ||
				/^(linear|radial)-gradient\([\w\s#.,%()+-]+\)$/.test(value),
		),
	padding: z.number().min(0).max(100),
	borderRadius: z.number().min(0).max(64),
	shadowIntensity: z.number().min(0).max(1),
	webcamMaskShape: z.enum(["rectangle", "circle", "square", "rounded", "squircle"]),
	webcamCornerRadius: z.number().min(0).max(50).optional(),
});
const captionSchema = z
	.object({
		fontFamily: z.string().min(1).max(256),
		fontSize: z.number().min(12).max(200),
		fontWeight: z.enum(["normal", "bold"]),
		color,
		backgroundEnabled: z.boolean(),
		backgroundColor: color,
		backgroundOpacity: z.number().min(0).max(1),
		verticalPosition: z.enum(["top", "middle", "bottom"]),
		textAlign: z.enum(["left", "center", "right"]),
		offsetY: z.number().min(-45).max(45),
		width: z.number().min(20).max(100),
		minWordsPerLine: z.number().int().min(1).max(12),
		maxWordsPerLine: z.number().int().min(1).max(12),
	})
	.refine((value) => value.minWordsPerLine <= value.maxWordsPerLine);
const appearanceSchema = z.object({ frame: frameSchema, captions: captionSchema });
export const visualPresetSchema = z.object({
	id: z.string().min(1).max(128),
	name: z.string().trim().min(1).max(48),
	appearance: appearanceSchema,
});
export type VisualPreset = z.infer<typeof visualPresetSchema>;
const librarySchema = z.object({
	version: z.literal(1),
	presets: z.array(visualPresetSchema).max(20),
});
export const VISUAL_PRESET_STORAGE_KEY = "klippt.visual-presets:v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function captureVisualPreset(
	document: AxcutDocument,
	name: string,
	id: string,
): VisualPreset {
	return visualPresetSchema.parse({
		id,
		name,
		appearance: {
			frame: getEditorSettings(document),
			captions: getCaptionSettings(document),
		},
	});
}

export function applyVisualPreset(document: AxcutDocument, preset: VisualPreset): AxcutDocument {
	const { appearance } = visualPresetSchema.parse(preset);
	return patchCaptionSettings(patchEditorSettings(document, appearance.frame), appearance.captions);
}

export function loadVisualPresets(storage: Storage = localStorage): VisualPreset[] {
	try {
		const raw = storage.getItem(VISUAL_PRESET_STORAGE_KEY);
		if (!raw || raw.length > 128_000) return [];
		const result = librarySchema.safeParse(JSON.parse(raw));
		return result.success ? result.data.presets : [];
	} catch {
		return [];
	}
}

export function saveVisualPresets(presets: VisualPreset[], storage: Storage = localStorage): void {
	const value = librarySchema.parse({ version: 1, presets });
	if (
		new Set(value.presets.map((preset) => preset.name.toLocaleLowerCase())).size !== presets.length
	)
		throw new Error("DUPLICATE_PRESET_NAME");
	storage.setItem(VISUAL_PRESET_STORAGE_KEY, JSON.stringify(value));
}

const captions = {
	fontFamily: "Geist",
	fontSize: 44,
	fontWeight: "bold" as const,
	color: "#ffffff",
	backgroundEnabled: true,
	backgroundColor: "#111318",
	backgroundOpacity: 0.85,
	verticalPosition: "bottom" as const,
	textAlign: "center" as const,
	offsetY: -2,
	width: 72,
	minWordsPerLine: 3,
	maxWordsPerLine: 6,
};
export const BUILTIN_VISUAL_PRESETS: readonly VisualPreset[] = [
	{
		id: "builtin-clean",
		name: "Clean",
		appearance: {
			frame: {
				wallpaper: "#20252e",
				padding: 36,
				borderRadius: 24,
				shadowIntensity: 0.2,
				webcamMaskShape: "squircle",
				webcamCornerRadius: 28,
			},
			captions,
		},
	},
	{
		id: "builtin-contrast",
		name: "High contrast",
		appearance: {
			frame: {
				wallpaper: "#101114",
				padding: 24,
				borderRadius: 16,
				shadowIntensity: 0.12,
				webcamMaskShape: "squircle",
				webcamCornerRadius: 24,
			},
			captions: {
				...captions,
				fontSize: 52,
				backgroundColor: "#000000",
				backgroundOpacity: 0.95,
				width: 76,
			},
		},
	},
];

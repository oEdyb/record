import { z } from "zod";
import { MAX_WEBCAM_ZOOM, MIN_WEBCAM_ZOOM } from "../../src/components/video-editor/types";
import { getCaptionSettings } from "../../src/lib/ai-edition/captions/settings";
import {
	MAX_OUTPUT_DIMENSION,
	MIN_OUTPUT_DIMENSION,
} from "../../src/lib/ai-edition/document/outputFormat";
import { cameraAnchorSchema, cameraSizeSchema } from "../../src/lib/ai-edition/layout/schema";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import { visualPresetSchema } from "../../src/lib/ai-edition/store/visualPresets";
import {
	MAX_WEBCAM_BLOCK_CAMERA_SHARE,
	MAX_WEBCAM_SIZE_PERCENT,
	MIN_WEBCAM_BLOCK_CAMERA_SHARE,
	MIN_WEBCAM_SIZE_PERCENT,
} from "../../src/lib/compositeLayout";
import { CURSOR_THEME_IDS } from "../../src/lib/cursor/cursorThemes";
import {
	MAX_SCREEN_FRAMING_SCALE,
	MIN_SCREEN_FRAMING_SCALE,
	resolveScreenFraming,
	screenFramingVariantKey,
} from "../../src/lib/screenFraming";
import { type AspectRatio, isAspectRatio } from "../../src/utils/aspectRatioUtils";

const captionSettingsSchema = visualPresetSchema.shape.appearance.shape.captions;
export const agentCaptionSettingsSchema = z
	.strictObject({
		...captionSettingsSchema.shape,
		enabled: z.boolean(),
		language: z.string().min(1).max(64).nullable(),
	})
	.partial()
	.refine(
		(v) =>
			v.minWordsPerLine === undefined ||
			v.maxWordsPerLine === undefined ||
			v.minWordsPerLine <= v.maxWordsPerLine,
		"Minimum words must not exceed maximum words.",
	);
const unit = z.number().finite().min(0).max(1);
const position = z.strictObject({ cx: unit, cy: unit });
const percent = z.number().finite().min(0).max(100);
const crop = z
	.strictObject({ x: unit, y: unit, width: unit.positive(), height: unit.positive() })
	.refine((v) => v.x + v.width <= 1 && v.y + v.height <= 1, "Crop must fit inside the source.");
const dimension = z
	.number()
	.int()
	.min(MIN_OUTPUT_DIMENSION)
	.max(MAX_OUTPUT_DIMENSION)
	.refine((v) => v % 2 === 0, "Output dimension must be even.");
export const agentEditorSettingsSchema = z
	.strictObject({
		wallpaper: z
			.union([
				visualPresetSchema.shape.appearance.shape.frame.shape.wallpaper,
				z
					.string()
					.max(1024 * 1024)
					.regex(/^data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/]+={0,2}$/),
			])
			.optional(),
		shadowIntensity: unit.optional(),
		showBlur: z.boolean().optional(),
		motionBlurAmount: unit.optional(),
		borderRadius: z.number().min(0).max(64).optional(),
		webcamBlockCameraShare: z
			.number()
			.min(MIN_WEBCAM_BLOCK_CAMERA_SHARE)
			.max(MAX_WEBCAM_BLOCK_CAMERA_SHARE)
			.optional(),
		screenFramingByVariant: z
			.record(
				z.string().min(1).max(64),
				z.strictObject({ scale: z.number().min(1).max(4), focalPoint: position }),
			)
			.refine((v) => Object.keys(v).length <= 32, "At most 32 variants.")
			.optional(),
		cursor: z
			.strictObject({
				size: z.number().min(0.5).max(10).optional(),
				smoothing: unit.optional(),
				motionBlur: unit.optional(),
				clickBounce: z.number().min(0).max(5).optional(),
				clipToBounds: z.boolean().optional(),
			})
			.optional(),
		cursorShow: z.boolean().optional(),
		cursorTheme: z.enum([...CURSOR_THEME_IDS]).optional(),
		autoFocusAll: z.boolean().optional(),
		microphoneVolume: unit.optional(),
		microphoneMuted: z.boolean().optional(),
		systemAudioVolume: unit.optional(),
		systemAudioMuted: z.boolean().optional(),
		evenVolume: z.boolean().optional(),
		normalizeVolume: z.boolean().optional(),
		audioDeliveryPreset: z.enum(["youtube", "custom"]).optional(),
		audioTargetLufs: z.number().min(-30).max(-9).optional(),
		audioPeakCeilingDbtp: z.number().min(-6).max(-1).optional(),

		cameraAnchor: cameraAnchorSchema.optional(),
		cameraSize: cameraSizeSchema.optional(),
		captions: z.union([z.boolean(), agentCaptionSettingsSchema]).optional(),
		safeMarginPercent: z.number().finite().min(0).max(50).optional(),
		aspectRatio: z
			.custom<AspectRatio>(
				(v) => isAspectRatio(v) && v !== "native",
				"Use an explicit positive W:H ratio.",
			)
			.optional(),
		outputResolution: z.strictObject({ width: dimension, height: dimension }).nullable().optional(),
		webcamLayoutPreset: z
			.enum(["picture-in-picture", "vertical-stack", "dual-frame", "no-webcam"])
			.optional(),
		webcamPosition: position.nullable().optional(),
		webcamSizePreset: z
			.number()
			.finite()
			.min(MIN_WEBCAM_SIZE_PERCENT)
			.max(MAX_WEBCAM_SIZE_PERCENT)
			.optional(),
		webcamMaskShape: z.enum(["rectangle", "circle", "square", "rounded", "squircle"]).optional(),
		webcamMirrored: z.boolean().optional(),
		webcamReactiveZoom: z.boolean().optional(),
		webcamCornerRadius: z.number().min(0).max(50).optional(),
		webcamAspectRatio: z.enum(["source", "1:1", "4:3", "16:9", "9:16"]).optional(),
		webcamZoom: z.number().finite().min(MIN_WEBCAM_ZOOM).max(MAX_WEBCAM_ZOOM).optional(),
		webcamFocalPoint: position.optional(),
		screenFraming: z
			.strictObject({
				scale: z.number().finite().min(MIN_SCREEN_FRAMING_SCALE).max(MAX_SCREEN_FRAMING_SCALE),
				focalPoint: position,
			})
			.optional(),
		webcamBlockOrder: z.enum(["screen-first", "camera-first"]).optional(),
		padding: percent.optional(),
		cropRegion: crop.optional(),
	})
	.refine((v) => Object.keys(v).length > 0, "At least one editor setting is required.")
	.refine(
		(v) => v.cameraAnchor === undefined || v.webcamPosition === undefined,
		"Use cameraAnchor or webcamPosition.",
	)
	.refine(
		(v) => v.cameraSize === undefined || v.webcamSizePreset === undefined,
		"Use cameraSize or webcamSizePreset.",
	);

export const agentLayoutSettingsSchema = agentEditorSettingsSchema;

const meanings: Record<string, [string, string]> = {
	safeMarginPercent: ["%", "Inset used by named anchors."],
	cameraAnchor: ["anchor", "Default camera anchor or normalized center."],
	cameraSize: ["%", "Named camera size or percent of output height."],
	wallpaper: ["CSS/path", "Background color, gradient, bundled wallpaper, or uploaded PNG/JPEG."],
	aspectRatio: ["W:H", "Output frame proportions."],
	outputResolution: ["px", "Explicit output dimensions; null uses the aspect ratio."],
	screenFraming: ["scale/normalized", "Screen crop for the current output variant."],
	screenFramingByVariant: ["scale/normalized", "Screen crops indexed by output variant."],
	shadowIntensity: ["fraction", "Strength of the screen shadow."],
	showBlur: ["boolean", "Blur the background."],
	motionBlurAmount: ["fraction", "Motion blur strength during movement."],
	borderRadius: ["px", "Screen frame corner radius."],
	padding: ["%", "Space around the screen frame."],
	cropRegion: ["normalized", "Source screen crop rectangle."],
	webcamLayoutPreset: ["enum", "Base arrangement of screen and camera."],
	webcamBlockOrder: ["enum", "Screen and camera order in block layouts."],
	webcamBlockCameraShare: ["%", "Camera share of a block layout."],
	webcamMaskShape: ["enum", "Camera mask shape."],
	webcamCornerRadius: ["%", "Camera rounding relative to its shorter side."],
	webcamAspectRatio: ["W:H", "Camera crop proportions."],
	webcamMirrored: ["boolean", "Mirror the camera horizontally."],
	webcamReactiveZoom: ["boolean", "Camera responds to screen zooms."],
	webcamSizePreset: ["%", "Camera size relative to output height."],
	webcamZoom: ["×", "Camera source crop scale."],
	webcamFocalPoint: ["normalized", "Center of the camera source crop."],
	webcamPosition: ["normalized", "Camera center; null uses default placement."],
	cursor: ["object", "Cursor size, movement, blur, bounce, and clipping."],
	cursorShow: ["boolean", "Show the recorded cursor."],
	cursorTheme: ["enum", "Installed cursor artwork."],
	autoFocusAll: ["boolean", "Follow the cursor in all zoom regions."],
	microphoneVolume: ["gain", "Microphone source volume."],
	microphoneMuted: ["boolean", "Mute the microphone source."],
	systemAudioVolume: ["gain", "System audio source volume."],
	systemAudioMuted: ["boolean", "Mute the system audio source."],
	evenVolume: ["boolean", "Even out speech loudness."],
	normalizeVolume: ["boolean", "Master output to the delivery loudness target."],
	audioDeliveryPreset: ["enum", "YouTube uses fixed targets; custom enables manual targets."],
	audioTargetLufs: ["LUFS", "Output loudness target; requires custom delivery."],
	audioPeakCeilingDbtp: ["dBTP", "Output true-peak ceiling; requires custom delivery."],
	captions: ["object/boolean", "Caption visibility, language, font, colors, and placement."],
};

export function describeAgentSettings(document: AxcutDocument) {
	const current = { ...getEditorSettings(document), captions: getCaptionSettings(document) };
	const defaults = { ...getEditorSettings(null), captions: getCaptionSettings(null) };
	const values = new Map<string, unknown>(Object.entries(current));
	values.set("cameraSize", current.webcamSizePreset);
	values.set(
		"screenFraming",
		resolveScreenFraming(
			current.screenFramingByVariant,
			screenFramingVariantKey(current.aspectRatio, current.outputResolution),
		),
	);
	const defaultValues = new Map<string, unknown>(Object.entries(defaults));
	defaultValues.set("cameraSize", defaults.webcamSizePreset);
	defaultValues.set("screenFraming", { scale: 1, focalPoint: { cx: 0.5, cy: 0.5 } });
	return Object.fromEntries(
		["frame", "camera", "cursor", "audio", "captions"].map((group) => [
			group,
			Object.entries(agentEditorSettingsSchema.shape)
				.filter(([key]) => {
					const category =
						key === "captions"
							? "captions"
							: /^(webcam|camera)/.test(key)
								? "camera"
								: /^(cursor|autoFocus)/.test(key)
									? "cursor"
									: /^(audio|microphone|systemAudio|evenVolume|normalizeVolume)/.test(key)
										? "audio"
										: "frame";
					return category === group;
				})
				.map(([key, schema]) => ({
					key,
					current: values.get(key) ?? null,
					default: defaultValues.get(key) ?? null,
					allowed: {
						...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
						...(key === "aspectRatio"
							? {
									type: "string",
									description: "Explicit positive finite W:H ratio; native is rejected.",
								}
							: {}),
					},
					unit: meanings[key][0],
					meaning: meanings[key][1],
					...(["cursor", "captions"].includes(key)
						? { fields: describeNestedSettings(key, values.get(key), defaultValues.get(key)) }
						: {}),
				})),
		]),
	);
}

export function parseSettingAssignments(assignments: string[]) {
	const patch: Record<string, unknown> = {};
	const seen = new Set<string>();
	for (const assignment of assignments) {
		const equals = assignment.indexOf("=");
		if (equals < 1) throw new Error("Use key=value assignments.");
		const key = assignment.slice(0, equals),
			raw = assignment.slice(equals + 1);
		if (seen.has(key)) throw new Error(`Duplicate setting: ${key}`);
		seen.add(key);
		let value: unknown = raw;
		try {
			value = JSON.parse(raw);
		} catch {
			/* Unquoted enum and vocabulary names are strings. */
		}
		const parts = key.split(".");
		if (parts.length === 1) {
			if (Object.getOwnPropertyDescriptor(patch, key) !== undefined)
				throw new Error(`Conflicting setting: ${key}`);
			Object.defineProperty(patch, key, { value, enumerable: true, configurable: true });
		} else if (parts.length === 2 && ["cursor", "captions"].includes(parts[0])) {
			if (seen.has(parts[0])) throw new Error(`Conflicting setting: ${key}`);
			const parent = z.record(z.string(), z.unknown()).parse(patch[parts[0]] ?? {});
			Object.defineProperty(parent, parts[1], { value, enumerable: true });
			patch[parts[0]] = parent;
		} else throw new Error(`Unknown setting: ${key}`);
	}
	return agentEditorSettingsSchema.parse(patch);
}

const nestedMeanings: Record<string, [string, string]> = {
	"cursor.size": ["×", "Cursor artwork scale."],
	"cursor.smoothing": ["fraction", "Cursor path smoothing strength."],
	"cursor.motionBlur": ["fraction", "Cursor motion blur strength."],
	"cursor.clickBounce": ["0..5 (UI ×20%)", "Cursor bounce on clicks."],
	"cursor.clipToBounds": ["boolean", "Keep the cursor inside the screen layer."],
	"captions.enabled": ["boolean", "Show the global caption layer."],
	"captions.language": [
		"language code",
		"Display translation language; null uses the transcript language.",
	],
	"captions.fontFamily": ["font name", "Caption typeface."],
	"captions.fontSize": ["px at 1080p", "Caption text size."],
	"captions.fontWeight": ["enum", "Caption text weight."],
	"captions.color": ["hex", "Caption text color."],
	"captions.backgroundEnabled": ["boolean", "Show the caption background plate."],
	"captions.backgroundColor": ["hex", "Caption plate color."],
	"captions.backgroundOpacity": ["fraction", "Caption plate opacity."],
	"captions.verticalPosition": ["enum", "Vertical caption anchor."],
	"captions.textAlign": ["enum", "Text alignment within the caption band."],
	"captions.offsetY": ["% of frame height", "Vertical offset from the caption anchor."],
	"captions.width": ["% of frame width", "Caption band width."],
	"captions.minWordsPerLine": ["words", "Fewest words per caption line."],
	"captions.maxWordsPerLine": ["words", "Most words per caption line."],
};
function describeNestedSettings(key: string, current: unknown, defaults: unknown) {
	const shape =
		key === "cursor"
			? agentEditorSettingsSchema.shape.cursor.unwrap().shape
			: agentCaptionSettingsSchema.shape;
	const values = z.record(z.string(), z.unknown()).parse(current);
	const defaultValues = z.record(z.string(), z.unknown()).parse(defaults);
	return Object.entries(shape).map(([field, schema]) => ({
		key: `${key}.${field}`,
		current: values[field],
		default: defaultValues[field],
		allowed: z.toJSONSchema(schema, { io: "input" }),
		unit: nestedMeanings[`${key}.${field}`][0],
		meaning: nestedMeanings[`${key}.${field}`][1],
	}));
}

export function formatAgentSettings(data: unknown) {
	const rowSchema = z.looseObject({
		key: z.string(),
		current: z.unknown(),
		default: z.unknown(),
		allowed: z.record(z.string(), z.unknown()),
		unit: z.string(),
		meaning: z.string(),
	});
	const groups = z
		.object({
			groups: z.record(
				z.string(),
				z.array(rowSchema.extend({ fields: z.array(rowSchema).optional() })),
			),
		})
		.parse(data).groups;
	return Object.entries(groups)
		.map(
			([group, rows]) =>
				`${group}:\n${rows
					.flatMap((row) => [row, ...(row.fields ?? [])])
					.map(
						(row) =>
							`  ${row.key}=${JSON.stringify(row.current)} (default ${JSON.stringify(row.default)}; ${row.unit}; allowed ${JSON.stringify(row.allowed)}) — ${row.meaning}`,
					)
					.join("\n")}`,
		)
		.join("\n");
}

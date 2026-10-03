import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { agentAutomaticSettingsSchema } from "../../src/lib/ai-edition/agent/automaticSettings";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import {
	captureVisualPreset,
	visualPresetSchema,
} from "../../src/lib/ai-edition/store/visualPresets";
import { readAutomaticDirectionSettings } from "../../src/lib/ai-edition/timeline/automatic-direction-settings";
import { agentEditorSettingsSchema } from "../ai-edition/agentEditorSettings";

const layoutSchema = z.strictObject(agentEditorSettingsSchema.shape).pick({
	cameraAnchor: true,
	safeMarginPercent: true,
	webcamLayoutPreset: true,
	webcamPosition: true,
	webcamSizePreset: true,
	webcamBlockOrder: true,
	webcamBlockCameraShare: true,
	webcamAspectRatio: true,
	webcamMirrored: true,
	webcamReactiveZoom: true,
	webcamZoom: true,
	webcamFocalPoint: true,
	aspectRatio: true,
	screenFramingByVariant: true,
	showBlur: true,
	motionBlurAmount: true,
});
export const agentPresetSchema = visualPresetSchema.extend({
	layout: layoutSchema,
	automaticDirection: agentAutomaticSettingsSchema,
});
export type AgentPreset = z.infer<typeof agentPresetSchema>;
const librarySchema = z
	.strictObject({ version: z.literal(1), presets: z.array(agentPresetSchema).max(20) })
	.refine(
		(v) => new Set(v.presets.map((p) => p.name.toLowerCase())).size === v.presets.length,
		"Duplicate preset name.",
	);

export function captureAgentPreset(document: AxcutDocument, name: string): AgentPreset {
	const settings = getEditorSettings(document);
	const layout = layoutSchema.parse(
		Object.fromEntries(
			Object.keys(layoutSchema.shape)
				.filter((key) => key !== "webcamPosition" || settings.cameraAnchor === undefined)
				.map((key) => [key, Reflect.get(settings, key)]),
		),
	);
	const automatic = readAutomaticDirectionSettings(document);
	return agentPresetSchema.parse({
		...captureVisualPreset(document, name, randomUUID()),
		layout,
		automaticDirection: { policy: automatic.policy, presetId: automatic.presetId },
	});
}

export function presetOperations(preset: AgentPreset | z.infer<typeof visualPresetSchema>) {
	return [
		{
			type: "set-layout",
			settings: {
				...preset.appearance.frame,
				captions: preset.appearance.captions,
				...("layout" in preset ? preset.layout : {}),
			},
		},
		...("automaticDirection" in preset
			? [{ type: "setAutomaticDirectionSettings", settings: preset.automaticDirection }]
			: []),
	];
}

export function createAgentPresetStore(directory: string) {
	const file = path.join(directory, "agent-presets.json");
	let pending: Promise<unknown> = Promise.resolve();
	const read = async () => {
		try {
			const handle = await fs.open(file, "r");
			try {
				if ((await handle.stat()).size > 1024 * 1024) throw new Error("PRESET_LIBRARY_TOO_LARGE");
				return librarySchema.parse(JSON.parse(await handle.readFile("utf8"))).presets;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				return [];
			throw error;
		}
	};
	const update = (change: (presets: AgentPreset[]) => AgentPreset[]) => {
		const run = pending.then(async () => {
			const value = librarySchema.parse({ version: 1, presets: change(await read()) });
			const temp = `${file}.${randomUUID()}.tmp`;
			await fs.mkdir(directory, { recursive: true });
			try {
				await fs.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
				await fs.rename(temp, file);
			} finally {
				await fs.unlink(temp).catch(() => undefined);
			}
			return value.presets;
		});
		pending = run.catch(() => undefined);
		return run;
	};
	return {
		read,
		save: (preset: AgentPreset) =>
			update((presets) => {
				if (presets.some((p) => p.name.toLowerCase() === preset.name.toLowerCase()))
					throw new Error("PRESET_ALREADY_EXISTS: Delete it explicitly before saving again.");
				return [...presets, preset];
			}),
		delete: (name: string) =>
			update((presets) => {
				if (!presets.some((p) => p.name.toLowerCase() === name.toLowerCase()))
					throw new Error("PRESET_NOT_FOUND");
				return presets.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
			}),
	};
}

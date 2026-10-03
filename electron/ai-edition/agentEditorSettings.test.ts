import { describe, expect, it } from "vitest";
import { getCaptionSettings } from "../../src/lib/ai-edition/captions/settings";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	DEFAULT_EDITOR_SETTINGS,
	getEditorSettings,
} from "../../src/lib/ai-edition/store/editorSettings";
import {
	agentEditorSettingsSchema,
	describeAgentSettings,
	parseSettingAssignments,
} from "./agentEditorSettings";
import { prepareAgentEditPlan } from "./agentEditPlan";

const document = () => createEmptyDocument({ projectId: "p", title: "Settings" });
describe("agent editor settings", () => {
	it("covers every default and optional editor snapshot key", () => {
		for (const key of [
			...Object.keys(DEFAULT_EDITOR_SETTINGS),
			"cameraAnchor",
			"webcamCornerRadius",
			"webcamAspectRatio",
		])
			expect(agentEditorSettingsSchema.shape).toHaveProperty(key);
		expect(agentEditorSettingsSchema.safeParse(DEFAULT_EDITOR_SETTINGS).success).toBe(true);
		const rows = Object.values(describeAgentSettings(document())).flat();
		expect(rows.length).toBe(Object.keys(agentEditorSettingsSchema.shape).length);
		for (const row of rows) {
			expect(row.meaning.length).toBeGreaterThan(5);
			expect(row.unit).toBeTruthy();
			expect(row).toHaveProperty("current");
			expect(row).toHaveProperty("default");
		}
	});
	it.each([
		"motionBlurAmount=1.1",
		"padding=-1",
		"borderRadius=65",
		"cursor.size=0.1",
		"cursor.clickBounce=6",
		"audioTargetLufs=-8",
		"webcamBlockCameraShare=90",
		"unknown=1",
		"captions.fontSize=201",
		"cursorTheme=uninstalled",
	])("rejects %s", (value) => expect(() => parseSettingAssignments([value])).toThrow());
	it("applies settings, nested cursor values, captions and vocabulary through a plan", () => {
		const base = document();
		const plan = prepareAgentEditPlan(base, [
			{
				type: "set-layout",
				settings: parseSettingAssignments([
					"motionBlurAmount=0.3",
					"cameraAnchor=top-left",
					"cameraSize=M",
					"cursor.size=2",
					"cursorShow=false",
					"captions.fontSize=60",
					"captions.enabled=true",
					"audioDeliveryPreset=custom",
					"audioTargetLufs=-16",
				]),
			},
		]);
		expect(getEditorSettings(plan.candidate)).toMatchObject({
			motionBlurAmount: 0.3,
			cameraAnchor: "top-left",
			webcamSizePreset: 26,
			cursor: { size: 2 },
			cursorShow: false,
			audioTargetLufs: -16,
		});
		expect(getCaptionSettings(plan.candidate)).toMatchObject({ enabled: true, fontSize: 60 });
		expect(getEditorSettings(base).motionBlurAmount).toBe(0.2);
	});
	it("rejects conflicts and caption cross-field errors against existing state", () => {
		expect(() => parseSettingAssignments(["padding=1", "padding=2"])).toThrow();
		expect(() => parseSettingAssignments(["cursor.size=2", 'cursor={"size":3}'])).toThrow();
		expect(() =>
			prepareAgentEditPlan(document(), [
				{ type: "set-layout", settings: { captions: { minWordsPerLine: 12 } } },
			]),
		).toThrow("INVALID_CAPTION_WORD_RANGE");
	});
});

it("accepts uploaded PNG/JPEG wallpaper values through the plan schema", () => {
	expect(
		agentEditorSettingsSchema.parse({ wallpaper: "data:image/png;base64,YQ==" }).wallpaper,
	).toBe("data:image/png;base64,YQ==");
	expect(agentEditorSettingsSchema.safeParse({ wallpaper: "file:///private/file" }).success).toBe(
		false,
	);
});

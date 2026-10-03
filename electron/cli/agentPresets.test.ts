import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	getCaptionSettings,
	patchCaptionSettings,
} from "../../src/lib/ai-edition/captions/settings";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	getEditorSettings,
	patchEditorSettings,
} from "../../src/lib/ai-edition/store/editorSettings";
import {
	readAutomaticDirectionSettings,
	writeAutomaticDirectionSettings,
} from "../../src/lib/ai-edition/timeline/automatic-direction-settings";
import { prepareAgentEditPlan } from "../ai-edition/agentEditPlan";
import { captureAgentPreset, createAgentPresetStore, presetOperations } from "./agentPresets";

const document = () => createEmptyDocument({ projectId: "p", title: "Presets" });
describe("agent preset library", () => {
	it("round trips frame, captions, layout and automatic policy through disk and plan", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-presets-"));
		try {
			let source = patchCaptionSettings(
				patchEditorSettings(document(), {
					motionBlurAmount: 0.3,
					webcamSizePreset: 44,
					cameraAnchor: "top-left",
					wallpaper: "#123456",
				}),
				{ fontSize: 64 },
			);
			const automatic = readAutomaticDirectionSettings(source);
			automatic.policy.maximumScreenScale = 2.5;
			source = writeAutomaticDirectionSettings(source, automatic);
			const store = createAgentPresetStore(dir);
			await store.save(captureAgentPreset(source, "night"));
			const loaded = await createAgentPresetStore(dir).read();
			expect(loaded).toHaveLength(1);
			const target = prepareAgentEditPlan(document(), presetOperations(loaded[0])).candidate;
			expect(getEditorSettings(target)).toMatchObject({
				wallpaper: "#123456",
				webcamSizePreset: 44,
				cameraAnchor: "top-left",
				motionBlurAmount: 0.3,
			});
			expect(getCaptionSettings(target).fontSize).toBe(64);
			expect(readAutomaticDirectionSettings(target).policy).toEqual(automatic.policy);
			await expect(store.save(captureAgentPreset(source, "NIGHT"))).rejects.toThrow(
				"PRESET_ALREADY_EXISTS",
			);
			await store.delete("NIGHT");
			expect(await store.read()).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("serializes concurrent saves and refuses to overwrite corrupt storage", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-presets-"));
		try {
			const store = createAgentPresetStore(dir);
			await Promise.all([
				store.save(captureAgentPreset(document(), "a")),
				store.save(captureAgentPreset(document(), "b")),
			]);
			expect(await store.read()).toHaveLength(2);
			await fs.writeFile(path.join(dir, "agent-presets.json"), "broken");
			await expect(store.save(captureAgentPreset(document(), "c"))).rejects.toThrow();
			expect(await fs.readFile(path.join(dir, "agent-presets.json"), "utf8")).toBe("broken");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

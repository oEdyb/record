import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../schema";
import { DEFAULT_AUTOMATIC_DIRECTION_POLICY } from "./automatic-direction";
import {
	automaticDirectionNumberControls,
	deleteAutomaticDirectionPreset,
	loadAutomaticDirectionPresets,
	normalizeAutomaticDirectionPolicy,
	policyForAutomaticDirectionPreset,
	readAutomaticDirectionSettings,
	saveAutomaticDirectionPreset,
	setAutomaticDirectionPolicyValue,
	writeAutomaticDirectionSettings,
} from "./automatic-direction-settings";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

describe("automatic direction settings", () => {
	it("exposes and normalizes held-attention controls and twelve-per-minute defaults", () => {
		const policy = normalizeAutomaticDirectionPolicy({});
		expect(policy.screen.maxZoomsPerMinute).toBe(12);
		expect(policy.camera.maxTotalDirectionPerMinute).toBe(12);
		const controls = automaticDirectionNumberControls(policy);
		for (const [key, label, value, max] of [
			["heldAttentionMaximumGapMs", "Held attention gap", 6_000, 60_000],
			["heldAttentionMaximumFocusDistance", "Held attention distance", 0.25, 2],
			["heldAttentionMaximumMovement", "Held attention movement", 0.25, 2],
		] as const) {
			expect(policy.connectedClicks[key]).toBe(value);
			expect(controls.find((control) => control.path === `connectedClicks.${key}`)).toMatchObject({
				label,
				min: 0,
				max,
				primary: false,
			});
			const changed = setAutomaticDirectionPolicyValue(policy, `connectedClicks.${key}`, value / 2);
			expect(changed.connectedClicks[key]).toBe(value / 2);
		}
		for (const path of ["screen.maxZoomsPerMinute", "camera.maxTotalDirectionPerMinute"]) {
			expect(controls.find((control) => control.path === path)).toMatchObject({ min: 1, max: 20 });
		}
	});

	it("validates unknown policy values and preserves the hard screen ceiling", () => {
		const policy = normalizeAutomaticDirectionPolicy({
			maximumScreenScale: 8,
			screen: {
				maxZoomsPerMinute: Number.NaN,
				minimumZoomDurationMs: 9_000,
				maximumZoomDurationMs: 2_000,
			},
			camera: { cameraScale: 9, motionBucketMs: 0 },
			microphoneActivity: {
				variationLowQuantile: 0.9,
				variationHighQuantile: 0.2,
			},
		});
		expect(policy.maximumScreenScale).toBe(5);
		expect(policy.screen.maxZoomsPerMinute).toBe(
			DEFAULT_AUTOMATIC_DIRECTION_POLICY.screen.maxZoomsPerMinute,
		);
		expect(policy.screen.minimumZoomDurationMs).toBe(2_000);
		expect(policy.screen.defaultZoomDurationMs).toBe(2_000);
		expect(policy.camera.cameraScale).toBe(2);
		expect(policy.camera.motionBucketMs).toBe(10);
		expect(policy.microphoneActivity.variationLowQuantile).toBe(0.2);
	});

	it("reads and writes one versioned project policy", () => {
		const document = createEmptyDocument({ title: "Direction", projectId: "project-1" });
		const policy = setAutomaticDirectionPolicyValue(
			DEFAULT_AUTOMATIC_DIRECTION_POLICY,
			"maximumScreenScale",
			1.4,
		);
		const saved = writeAutomaticDirectionSettings(document, { policy, presetId: null });
		const restored = readAutomaticDirectionSettings(saved);
		expect(restored.version).toBe(1);
		expect(restored.presetId).toBeNull();
		expect(restored.policy.maximumScreenScale).toBe(1.4);
	});

	it("lists every numeric policy leaf and marks Max Zoom as primary", () => {
		const controls = automaticDirectionNumberControls(DEFAULT_AUTOMATIC_DIRECTION_POLICY);
		expect(controls.find((control) => control.path === "maximumScreenScale")).toMatchObject({
			label: "Max Zoom",
			primary: true,
		});
		expect(controls.some((control) => control.path === "typing.typingIdleGapMs")).toBe(true);
		expect(
			controls.some((control) => control.path === "screen.clickEnvelopeScaleSteps.0.scale"),
		).toBe(true);
		expect(
			controls.some((control) => control.path === "connectedClicks.safetyFramesPerSecond"),
		).toBe(false);
		expect(
			controls.some((control) => control.path === "connectedClicks.scaleSearchIterations"),
		).toBe(false);
		expect(
			controls.some((control) => control.path.startsWith("connectedClicks.panMotionSpeeds.")),
		).toBe(false);
	});

	it("stores custom presets as overrides and can remove them", () => {
		const storage = memoryStorage();
		const policy = setAutomaticDirectionPolicyValue(
			DEFAULT_AUTOMATIC_DIRECTION_POLICY,
			"maximumScreenScale",
			1.45,
		);
		const preset = saveAutomaticDirectionPreset("Tutorial", policy, storage);
		expect(preset).not.toBeNull();
		expect(preset?.overrides).toEqual({ maximumScreenScale: 1.45 });
		expect(loadAutomaticDirectionPresets(storage)).toHaveLength(1);
		expect(policyForAutomaticDirectionPreset(preset!).maximumScreenScale).toBe(1.45);
		expect(deleteAutomaticDirectionPreset(preset!.id, storage)).toBe(true);
		expect(loadAutomaticDirectionPresets(storage)).toEqual([]);
	});
});

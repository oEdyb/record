import { z } from "zod";
import {
	type agentAutomaticSettingsSchema,
	resolveAgentAutomaticSettings,
} from "../../src/lib/ai-edition/agent/automaticSettings";
import { createId } from "../../src/lib/ai-edition/document/ids";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	applyAutomaticDirection,
	type RecordedDirectionObservation,
	regenerateAutomaticDirection,
	removeAutomaticDirection,
} from "../../src/lib/ai-edition/timeline/automatic-direction";
import { writeAutomaticDirectionSettings } from "../../src/lib/ai-edition/timeline/automatic-direction-settings";

export type AgentAutoOperation =
	| {
			type: "autoDirectionRun" | "autoDirectionRegenerate";
			settings?: z.infer<typeof agentAutomaticSettingsSchema>;
	  }
	| { type: "autoDirectionRemove" };

function regionIds(document: AxcutDocument) {
	const camera = z
		.array(z.object({ id: z.string(), mode: z.string().optional() }))
		.parse(document.legacyEditor?.cameraFullscreenRegions ?? []);
	return {
		zoom: new Set(document.zoomRanges.map((r) => r.id)),
		cameraEmphasis: new Set(camera.filter((r) => r.mode === "emphasis").map((r) => r.id)),
		cameraFullscreen: new Set(camera.filter((r) => r.mode !== "emphasis").map((r) => r.id)),
	};
}

export function applyAgentAutomaticDirection(
	document: AxcutDocument,
	operation: AgentAutoOperation,
	recordings?: RecordedDirectionObservation[],
) {
	let candidate: AxcutDocument;
	if (operation.type === "autoDirectionRemove") candidate = removeAutomaticDirection(document);
	else {
		if (
			!recordings ||
			recordings.every(
				(r) =>
					!r.cursorTelemetry.length && !r.keyboardActivity?.length && !r.microphoneActivity?.length,
			)
		)
			throw new Error(
				"DIRECTION_OBSERVATIONS_UNAVAILABLE: No recorded activity; existing edits were kept.",
			);
		if (operation.type === "autoDirectionRegenerate")
			assertRegenerationEvidence(document, recordings);
		const settings = resolveAgentAutomaticSettings(document, operation.settings);
		const run =
			operation.type === "autoDirectionRun"
				? applyAutomaticDirection
				: regenerateAutomaticDirection;
		candidate = writeAutomaticDirectionSettings(
			run({ id: createId("direction"), document, recordings, policy: settings.policy }),
			settings,
		);
	}
	const before = regionIds(document),
		after = regionIds(candidate);
	const counts = Object.fromEntries(
		(["zoom", "cameraEmphasis", "cameraFullscreen"] as const).map((kind) => {
			const ids = before[kind],
				next = after[kind];
			return [
				kind,
				{
					added: [...next].filter((id) => !ids.has(id)).length,
					removed: [...ids].filter((id) => !next.has(id)).length,
				},
			];
		}),
	);
	return { candidate, counts };
}

function assertRegenerationEvidence(
	document: AxcutDocument,
	recordings: RecordedDirectionObservation[],
) {
	const available = new Set(
		recordings
			.filter(
				(r) =>
					r.cursorTelemetry.length || r.keyboardActivity?.length || r.microphoneActivity?.length,
			)
			.map((r) => r.assetId),
	);
	const camera = z
		.array(
			z.object({
				source: z.string().optional(),
				clipId: z.string().optional(),
				startMs: z.number(),
				endMs: z.number(),
			}),
		)
		.parse(document.legacyEditor?.cameraFullscreenRegions ?? []);
	const automatic = [...document.zoomRanges, ...camera].filter((r) => r.source === "auto");
	for (const region of automatic) {
		const affected = document.timeline.clips.filter((clip) =>
			region.clipId
				? clip.id === region.clipId
				: clip.timelineStartSec * 1000 < region.endMs &&
					clip.timelineEndSec * 1000 > region.startMs,
		);
		if (affected.some((clip) => !available.has(clip.assetId)))
			throw new Error(
				"DIRECTION_OBSERVATIONS_INCOMPLETE: Existing automatic edits lack recorded activity; no edits were changed.",
			);
	}
}

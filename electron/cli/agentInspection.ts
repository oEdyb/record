import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AxcutAsset,
	type AxcutClip,
	type AxcutDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "../../src/lib/ai-edition/schema";

import type { AudioAsset, AudioClip } from "../../src/lib/ai-edition/schema/audioOverlays";

export const AGENT_PROJECT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

function bounded<T>(value: T, maximum = MAX_RESPONSE_BYTES): T {
	if (Buffer.byteLength(JSON.stringify(value)) > maximum) {
		throw new Error("INSPECTION_TOO_LARGE: Request a smaller range or item.");
	}
	return value;
}

function short(value: string): string {
	return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}

/** Read a bounded file handle, not a service that can relink or persist on load. */
export async function loadAgentDocument(projectPath: string) {
	const path = resolve(projectPath);
	const handle = await open(path, "r");
	let bytes: Buffer;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("INVALID_PROJECT: Expected a regular project file.");
		if (stat.size > AGENT_PROJECT_MAX_BYTES)
			throw new Error("PROJECT_TOO_LARGE: Maximum is 32 MiB.");
		// Read at most the advertised limit plus one even if the file grows after stat.
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= AGENT_PROJECT_MAX_BYTES) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, AGENT_PROJECT_MAX_BYTES + 1 - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (!bytesRead) break;
			chunks.push(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
		if (total > AGENT_PROJECT_MAX_BYTES) throw new Error("PROJECT_TOO_LARGE: Maximum is 32 MiB.");
		bytes = Buffer.concat(chunks, total);
	} finally {
		await handle.close();
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const raw: unknown = JSON.parse(bytes.toString("utf8"));
	const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	const legacy = record !== null && !Object.keys(record).includes("schemaVersion");
	let document: AxcutDocument;
	if (legacy) {
		const { validateProjectData } = await import(
			"../../src/components/video-editor/projectPersistence"
		);
		if (record.version !== 2 || !validateProjectData(raw)) {
			throw new Error(
				"INVALID_PROJECT: Expected a supported canonical document or version 2 project.",
			);
		}
		const { migrateProjectDataToAxcutDocument } = await import(
			"../../src/lib/ai-edition/document/migrate"
		);
		document = migrateProjectDataToAxcutDocument(raw, {
			projectId: `legacy_${sha256}`,
			createdAt: "1970-01-01T00:00:00.000Z",
		});
		// The shared adapter mints IDs. These read-only identities are stable for
		// the same input bytes; they are not IDs in a persisted migrated project.
		const assetIds = new Map(
			document.assets.map((asset, i) => [asset.id, `legacy_asset_${sha256}_${i}`]),
		);
		const clipIds = new Map(
			document.timeline.clips.map((clip, i) => [clip.id, `legacy_clip_${sha256}_${i}`]),
		);
		document.assets = document.assets.map((asset) => ({
			...asset,
			id: assetIds.get(asset.id) ?? asset.id,
		}));
		document.project.primaryAssetId = document.project.primaryAssetId
			? assetIds.get(document.project.primaryAssetId)
			: undefined;
		document.timeline.clips = document.timeline.clips.map((clip) => ({
			...clip,
			id: clipIds.get(clip.id) ?? clip.id,
			assetId: assetIds.get(clip.assetId) ?? clip.assetId,
		}));
		document.timeline.trimRanges = document.timeline.trimRanges.map((trim, i) => ({
			...trim,
			id: `legacy_trim_${sha256}_${i}`,
			assetId: assetIds.get(trim.assetId) ?? trim.assetId,
			...(trim.clipId ? { clipId: clipIds.get(trim.clipId) ?? trim.clipId } : {}),
		}));
		document = documentSchema.parse(document);
	} else {
		document = documentSchema.parse(migrateRawDocumentToCurrent(raw));
	}
	return {
		document,
		snapshot: {
			state: "saved_snapshot" as const,
			path,
			sha256,
			persistent_revision: null,
			input_schema_version: legacy ? 2 : record?.schemaVersion,
			identity: legacy ? ("derived_from_legacy_bytes" as const) : ("stored_document_ids" as const),
		},
		warnings: legacy
			? [
					"Legacy projection only: source duration was not probed; IDs are derived from file bytes. Open and save in Klippt for canonical IDs.",
				]
			: [],
	};
}

function clipSummary(clip: AxcutClip) {
	return {
		kind: "clip" as const,
		id: clip.id,
		asset_id: clip.assetId,
		origin: clip.origin,
		source: {
			time_base: "source_seconds" as const,
			start: clip.sourceStartSec,
			end: clip.sourceEndSec ?? null,
		},
		timeline: {
			time_base: "raw_virtual_seconds" as const,
			start: clip.timelineStartSec,
			end: clip.timelineEndSec,
		},
		crop: clip.cropRegion ?? null,
		word_reference_count: clip.wordRefs.length,
	};
}

function assetSummary(document: AxcutDocument, asset: AxcutAsset) {
	const transcript =
		document.transcripts.find((t) => t.assetId === asset.id) ??
		(document.transcript?.assetId === asset.id ? document.transcript : null);
	return {
		kind: "asset" as const,
		id: asset.id,
		label: short(asset.label),
		duration_seconds: asset.durationSec ?? null,
		video: asset.video ?? null,
		camera_linked: asset.cameraTrack !== null,
		media_health: "not_checked" as const,
		transcript: transcript
			? {
					status: "stored" as const,
					word_count: transcript.words.length,
					segment_count: transcript.segments.length,
				}
			: {
					status: asset.transcriptionFailure ? ("unavailable" as const) : ("not_stored" as const),
					failure: asset.transcriptionFailure?.kind ?? null,
				},
	};
}

function audioAssetSummary(asset: AudioAsset) {
	return {
		kind: "audio_asset" as const,
		id: asset.id,
		label: short(asset.label),
		duration_seconds: asset.durationSec,
		media_health: "not_checked" as const,
	};
}
function audioClipSummary(clip: AudioClip) {
	return {
		kind: "audio_clip" as const,
		id: clip.id,
		asset_id: clip.assetId,
		time_base: "edited_output_seconds" as const,
		start: clip.startSec,
		end: clip.endSec,
		source_offset_seconds: clip.sourceOffsetSec,
		gain: clip.gain,
		gain_unit: "linear_amplitude" as const,
		fade_in_seconds: clip.fadeInSec,
		fade_out_seconds: clip.fadeOutSec,
	};
}
function audioPage<T>(rows: T[], offset: number, limit: number) {
	const items = rows.slice(offset, offset + limit);
	const next = offset + items.length;
	return {
		items,
		total: rows.length,
		offset,
		limit,
		truncated: next < rows.length,
		next_offset: next < rows.length ? next : null,
	};
}

interface EffectSummary {
	kind: "zoom" | "annotation" | "camera_fullscreen" | "trim";
	id: string;
	time_base: "raw_virtual_milliseconds" | "source_seconds";
	start: number;
	end: number;
	clip_id?: string;
	annotation_type?: string;
}
function effectSummaries(document: AxcutDocument): EffectSummary[] {
	const effects: EffectSummary[] = [];
	for (const zoom of document.zoomRanges)
		effects.push({
			kind: "zoom",
			id: zoom.id,
			time_base: "raw_virtual_milliseconds",
			start: zoom.startMs,
			end: zoom.endMs,
			clip_id: zoom.clipId,
		});
	for (const annotation of document.annotations)
		effects.push({
			kind: "annotation",
			id: annotation.id,
			time_base: "raw_virtual_milliseconds",
			start: annotation.startMs,
			end: annotation.endMs,
			clip_id: annotation.clipId,
			annotation_type: annotation.type,
		});
	const cameras: unknown = document.legacyEditor?.cameraFullscreenRegions;
	if (Array.isArray(cameras))
		for (const row of cameras as unknown[]) {
			if (!row || typeof row !== "object") continue;
			const camera = row as Record<string, unknown>;
			if (
				typeof camera.id !== "string" ||
				typeof camera.startMs !== "number" ||
				typeof camera.endMs !== "number"
			)
				continue;
			effects.push({
				kind: "camera_fullscreen",
				id: camera.id,
				time_base: "raw_virtual_milliseconds",
				start: camera.startMs,
				end: camera.endMs,
				...(typeof camera.clipId === "string" ? { clip_id: camera.clipId } : {}),
			});
		}
	for (const trim of document.timeline.trimRanges)
		effects.push({
			kind: "trim",
			id: trim.id,
			time_base: "source_seconds",
			start: trim.startSec,
			end: trim.endSec,
			clip_id: trim.clipId,
		});
	return effects;
}

/** Metadata only. No filesystem/media probes, jobs, full transcript, or data URLs. */
export function inspectAgentProject(document: AxcutDocument) {
	const editor = document.legacyEditor;
	const effects = effectSummaries(document);
	const rawDuration = document.timeline.clips.reduce(
		(end, clip) => Math.max(end, clip.timelineEndSec),
		0,
	);
	const knownDuration = document.timeline.clips.every((clip) => clip.sourceEndSec !== undefined);
	return bounded(
		{
			id: document.project.id,
			title: short(document.project.title),
			schema_version: document.schemaVersion,
			state: "saved_snapshot" as const,
			live_editor_state: "unavailable" as const,
			duration: {
				time_base: "raw_virtual_seconds" as const,
				value: knownDuration ? rawDuration : null,
				edited_playback: "not_computed" as const,
			},
			counts: {
				assets: document.assets.length,
				audio_assets: document.audioAssets?.length ?? 0,
				audio_clips: document.timeline.audioClips?.length ?? 0,
				clips: document.timeline.clips.length,
				trims: document.timeline.trimRanges.length,
				zooms: document.zoomRanges.length,
				annotations: document.annotations.length,
				camera_fullscreen: effects.filter((effect) => effect.kind === "camera_fullscreen").length,
				effects: effects.length,
			},
			layout: {
				status: "stored_parameters_only" as const,
				aspect_ratio: typeof editor?.aspectRatio === "string" ? short(editor.aspectRatio) : null,
				webcam_layout:
					typeof editor?.webcamLayoutPreset === "string" ? short(editor.webcamLayoutPreset) : null,
			},
			analysis: {
				source_media: "not_checked" as const,
				background_jobs: "unavailable_in_saved_snapshot" as const,
				cursor: "not_loaded" as const,
				waveform: "not_loaded" as const,
			},
			assets: document.assets.slice(0, 20).map((asset) => assetSummary(document, asset)),
			assets_truncated: document.assets.length > 20,
			audio_assets: (document.audioAssets ?? []).slice(0, 5).map(audioAssetSummary),
			audio_assets_truncated: (document.audioAssets?.length ?? 0) > 5,
			audio_clips: (document.timeline.audioClips ?? []).slice(0, 5).map(audioClipSummary),
			audio_clips_truncated: (document.timeline.audioClips?.length ?? 0) > 5,
			clips: document.timeline.clips.slice(0, 20).map(clipSummary),
			clips_truncated: document.timeline.clips.length > 20,
			effects: audioPage(effects, 0, 20),
			effects_pagination:
				"timeline --offset <effects.next_offset> --limit 20 returns lanes.effects; order is zooms, annotations, camera regions, trims, then stored fragment order.",
		},
		32 * 1024,
	);
}

export function listAgentTimeline(
	document: AxcutDocument,
	options: { offset?: number; limit?: number } = {},
) {
	const offset = options.offset ?? 0;
	const limit = options.limit ?? 20;
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100
	) {
		throw new Error(
			"INVALID_ARGUMENT: offset must be a nonnegative safe integer; limit must be 1–100.",
		);
	}
	const items = document.timeline.clips.slice(offset, offset + limit).map(clipSummary);
	const next = offset + items.length;
	return bounded({
		items,
		lanes: {
			effects: audioPage(effectSummaries(document), offset, Math.min(limit, 20)),
			audio_clips: {
				...audioPage(
					(document.timeline.audioClips ?? []).map(audioClipSummary),
					offset,
					Math.min(limit, 20),
				),
				time_base: "edited_output_seconds" as const,
			},
			audio_assets: audioPage(
				(document.audioAssets ?? []).map(audioAssetSummary),
				offset,
				Math.min(limit, 20),
			),
			pagination:
				"Each lane has its own next_offset; pass it as --offset. Video items and offsets retain their existing meaning.",
		},
		total: document.timeline.clips.length,
		offset,
		truncated: next < document.timeline.clips.length,
		next_offset: next < document.timeline.clips.length ? next : null,
		time_base: "raw_virtual_seconds" as const,
	});
}

/** Duplicate region IDs can be separate fragments of one visible effect: return all matches. */
export function getAgentItem(document: AxcutDocument, id: string) {
	if (!id) throw new Error("INVALID_ARGUMENT: item ID is required.");
	const items: unknown[] = [];
	for (const asset of document.audioAssets ?? [])
		if (asset.id === id) items.push(audioAssetSummary(asset));
	for (const clip of document.timeline.audioClips ?? [])
		if (clip.id === id) items.push(audioClipSummary(clip));
	for (const clip of document.timeline.clips) if (clip.id === id) items.push(clipSummary(clip));
	for (const asset of document.assets)
		if (asset.id === id) items.push(assetSummary(document, asset));
	for (const effect of effectSummaries(document))
		if (effect.kind === "camera_fullscreen" && effect.id === id) items.push(effect);
	for (const zoom of document.zoomRanges)
		if (zoom.id === id)
			items.push({ kind: "zoom", time_base: "raw_virtual_milliseconds", ...zoom });
	for (const trim of document.timeline.trimRanges)
		if (trim.id === id) items.push({ kind: "trim", time_base: "source_seconds", ...trim });
	for (const annotation of document.annotations)
		if (annotation.id === id)
			items.push({
				kind: "annotation",
				id,
				type: annotation.type,
				time_base: "raw_virtual_milliseconds",
				startMs: annotation.startMs,
				endMs: annotation.endMs,
				position: annotation.position,
				size: annotation.size,
				content_included: false,
			});
	return bounded({ id, found: items.length > 0, items });
}

// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import {
	AGENT_PROJECT_MAX_BYTES,
	getAgentItem,
	inspectAgentProject,
	listAgentTimeline,
	loadAgentDocument,
} from "./agentInspection";

function fixture() {
	return documentSchema.parse({
		...createEmptyDocument({
			title: "Demo",
			projectId: "p",
			createdAt: "2026-09-07T00:00:00.000Z",
		}),
		assets: [
			{
				id: "a",
				kind: "video",
				label: "Screen",
				originalPath: "/missing/screen.mp4",
				durationSec: 12,
			},
		],
		timeline: {
			clips: [
				{
					id: "second-source-first",
					assetId: "a",
					sourceStartSec: 8,
					sourceEndSec: 12,
					timelineStartSec: 0,
					timelineEndSec: 4,
					origin: "user",
				},
				{
					id: "first-source-second",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 4,
					timelineEndSec: 8,
					origin: "user",
				},
			],
			trimRanges: [
				{
					id: "cut",
					assetId: "a",
					clipId: "first-source-second",
					startSec: 1,
					endSec: 2,
					origin: "user",
				},
			],
		},
		legacyEditor: {
			wallpaper: `data:image/png;base64,${"a".repeat(100_000)}`,
			aspectRatio: "16:9",
		},
	});
}

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "klippt-agent-inspection-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("saved agent inspection", () => {
	it("reads canonical schema without relinking media or writing a migrated copy", async () => {
		const path = join(directory, "Demo.klippt");
		const content = JSON.stringify(fixture());
		await writeFile(path, content);
		const first = await loadAgentDocument(path);
		const second = await loadAgentDocument(path);
		expect(first.document.assets[0].originalPath).toBe("/missing/screen.mp4");
		expect(first.snapshot).toMatchObject({
			state: "saved_snapshot",
			persistent_revision: null,
			identity: "stored_document_ids",
		});
		expect(first.snapshot.sha256).toBe(second.snapshot.sha256);
		expect(await readFile(path, "utf8")).toBe(content);
		expect(await readdir(directory)).toEqual(["Demo.klippt"]);
	});
	it("upgrades v8 only in memory and rejects future schema versions", async () => {
		const path = join(directory, "old.axcut");
		await writeFile(path, JSON.stringify({ ...fixture(), schemaVersion: 8 }));
		expect((await loadAgentDocument(path)).document.schemaVersion).toBe(11);
		expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(8);
		await writeFile(path, JSON.stringify({ ...fixture(), schemaVersion: 999 }));
		await expect(loadAgentDocument(path)).rejects.toThrow();
	});
	it("projects legacy files with repeatable inspection IDs and unknown duration", async () => {
		const path = join(directory, "old.openscreen");
		const content = JSON.stringify({
			version: 2,
			media: { screenVideoPath: "/media/demo.mp4", webcamVideoPath: "/media/camera.mp4" },
			editor: { trimRegions: [{ id: "old-cut", startMs: 100, endMs: 300 }] },
		});
		await writeFile(path, content);
		const first = await loadAgentDocument(path);
		const second = await loadAgentDocument(path);
		expect(first.document).toEqual(second.document);
		expect(first.document.timeline.trimRanges[0].clipId).toBe(first.document.timeline.clips[0].id);
		expect(first.document.timeline.clips[0].assetId).toBe(first.document.assets[0].id);
		expect(first.snapshot.identity).toBe("derived_from_legacy_bytes");
		expect(inspectAgentProject(first.document).duration.value).toBeNull();
		expect(first.warnings).toHaveLength(1);
		expect(await readFile(path, "utf8")).toBe(content);
		expect(await readdir(directory)).toEqual(["old.openscreen"]);
	});
	it("rejects malformed and oversized files before treating them as projects", async () => {
		const path = join(directory, "bad.klippt");
		await writeFile(path, "{bad");
		await expect(loadAgentDocument(path)).rejects.toThrow();
		await writeFile(
			path,
			JSON.stringify({ version: 77, editor: {}, videoPath: "/media/demo.mp4" }),
		);
		await expect(loadAgentDocument(path)).rejects.toThrow("INVALID_PROJECT");
		await truncate(path, AGENT_PROJECT_MAX_BYTES + 1);
		await expect(loadAgentDocument(path)).rejects.toThrow("PROJECT_TOO_LARGE");
	});
	it("does not imply absent evidence or unprobed media is ready", () => {
		const overview = inspectAgentProject(fixture());
		expect(overview.assets[0]).toMatchObject({
			media_health: "not_checked",
			transcript: { status: "not_stored" },
		});
		expect(overview.analysis.background_jobs).toBe("unavailable_in_saved_snapshot");
		expect(overview.duration).toEqual({
			time_base: "raw_virtual_seconds",
			value: 8,
			edited_playback: "not_computed",
		});
		expect(JSON.stringify(overview)).not.toContain("data:image");
		expect(JSON.stringify(overview)).not.toContain("/missing");
	});
	it("pages clips in edit order rather than source order, leaving source state unchanged", () => {
		const doc = fixture();
		const before = JSON.stringify(doc);
		const page = listAgentTimeline(doc, { limit: 1 });
		expect(page.items[0]).toMatchObject({
			id: "second-source-first",
			source: { start: 8 },
			timeline: { start: 0 },
		});
		expect(page).toMatchObject({ total: 2, truncated: true, next_offset: 1 });
		expect(listAgentTimeline(doc, { offset: 1, limit: 1 })).toMatchObject({
			truncated: false,
			next_offset: null,
		});
		expect(JSON.stringify(doc)).toBe(before);
		expect(() => listAgentTimeline(doc, { limit: 0 })).toThrow("INVALID_ARGUMENT");
		expect(() => listAgentTimeline(doc, { offset: Number.NaN })).toThrow("INVALID_ARGUMENT");
	});
	it("bounds overview clip lists and reports all fragments of a matched effect", () => {
		const doc = fixture();
		doc.timeline.clips = Array.from({ length: 25 }, (_, i) => ({
			...doc.timeline.clips[0],
			id: `clip-${i}`,
		}));
		doc.timeline.trimRanges.push({ ...doc.timeline.trimRanges[0], clipId: "clip-1" });
		expect(inspectAgentProject(doc)).toMatchObject({
			clips_truncated: true,
			counts: { clips: 25 },
		});
		expect(inspectAgentProject(doc).clips).toHaveLength(20);
		expect(getAgentItem(doc, "cut").items).toHaveLength(2);
		expect(getAgentItem(doc, "absent")).toEqual({ id: "absent", found: false, items: [] });
	});
	it("discovers editable audio IDs and output-time positions without changing video pagination", () => {
		const doc = fixture();
		doc.audioAssets = Array.from({ length: 22 }, (_, index) => ({
			id: `music-${index}`,
			label: "Music",
			originalPath: "/private/music.wav",
			durationSec: 20,
		}));
		doc.timeline.audioClips = doc.audioAssets.map((asset, index) => ({
			id: `audio-${index}`,
			assetId: asset.id,
			startSec: 2,
			endSec: 4,
			sourceOffsetSec: 1,
			gain: 0.25,
			fadeInSec: 0.5,
			fadeOutSec: 0.5,
		}));
		const overview = inspectAgentProject(doc);
		expect(overview.counts).toMatchObject({ audio_assets: 22, audio_clips: 22 });
		expect(overview.audio_clips_truncated).toBe(true);
		expect(overview.audio_clips).toHaveLength(5);
		const page = listAgentTimeline(doc, { limit: 100 });
		expect(page.total).toBe(2);
		expect(page.next_offset).toBeNull();
		expect(page.lanes.audio_clips).toMatchObject({
			total: 22,
			next_offset: 20,
			time_base: "edited_output_seconds",
		});
		expect(listAgentTimeline(doc, { offset: 20, limit: 100 }).lanes.audio_clips.items).toHaveLength(
			2,
		);
		expect(getAgentItem(doc, "audio-0").items).toEqual([
			expect.objectContaining({
				kind: "audio_clip",
				source_offset_seconds: 1,
				gain: 0.25,
				gain_unit: "linear_amplitude",
			}),
		]);
		expect(getAgentItem(doc, "music-0").items).toEqual([
			expect.objectContaining({ kind: "audio_asset", media_health: "not_checked" }),
		]);
		expect(JSON.stringify([overview, page, getAgentItem(doc, "music-0")])).not.toContain(
			"/private/",
		);
	});
	it("discovers effect IDs with deep pagination and exposes camera items without image payloads", () => {
		const doc = fixture();
		doc.zoomRanges = Array.from({ length: 22 }, (_, index) => ({
			id: `zoom-${index}`,
			startMs: index * 100,
			endMs: index * 100 + 200,
			depth: 2,
			focus: { cx: 0.5, cy: 0.5 },
		}));
		doc.legacyEditor = {
			...doc.legacyEditor,
			cameraFullscreenRegions: [
				{ id: "camera-region", startMs: 3000, endMs: 5000, mode: "emphasis" },
			],
		};
		const overview = inspectAgentProject(doc);
		expect(overview.effects).toMatchObject({ total: 24, next_offset: 20, truncated: true });
		expect(overview.effects.items[0]).toMatchObject({
			id: "zoom-0",
			kind: "zoom",
			time_base: "raw_virtual_milliseconds",
			start: 0,
			end: 200,
		});
		const next = listAgentTimeline(doc, { offset: 20, limit: 20 });
		expect(next.items).toEqual([]);
		expect(next.lanes.effects.items.map((effect) => effect.id)).toEqual([
			"zoom-20",
			"zoom-21",
			"camera-region",
			"cut",
		]);
		expect(next.lanes.effects.next_offset).toBeNull();
		expect(getAgentItem(doc, "camera-region")).toMatchObject({
			found: true,
			items: [{ kind: "camera_fullscreen", start: 3000, end: 5000 }],
		});
		expect(JSON.stringify(overview.effects)).not.toContain("data:image");
	});
});

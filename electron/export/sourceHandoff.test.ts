import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { inspectSourceAudioLayout } from "../stt/sourceAudio";
import { exportSourceHandoff } from "./sourceHandoff";

vi.mock("../stt/sourceAudio", () => ({ inspectSourceAudioLayout: vi.fn() }));
vi.mock("../media/audioPeaks", () => ({ resolveFfmpeg: () => null, audioTrackMapArgs: () => [] }));
let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "source-handoff-test-"));
	vi.mocked(inspectSourceAudioLayout)
		.mockReset()
		.mockResolvedValue({ hasAudio: false, hasKlipptMetadata: false, roles: [], durationSec: 10 });
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const screen = path.join(root, "screen.mp4");
	const camera = path.join(root, "camera.mp4");
	await fs.writeFile(screen, "screen-original");
	await fs.writeFile(camera, "camera-original");
	const doc = createEmptyDocument({ title: "../My take", projectId: "proj_sources" });
	doc.assets = [
		{
			id: "a",
			kind: "video",
			label: "Screen",
			originalPath: screen,
			cameraTrack: { sourcePath: camera, startMs: 0, offsetMs: -775, visible: false },
		},
		{
			id: "removed",
			kind: "video",
			label: "Removed",
			originalPath: path.join(root, "missing-removed.mp4"),
			cameraTrack: null,
		},
	];
	doc.timeline.clips = [
		{
			id: "c",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "Test",
		},
	];
	doc.timeline.trimRanges = [
		{
			id: "cut",
			clipId: "c",
			assetId: "a",
			startSec: 2,
			endSec: 4,
			origin: "user",
			reason: "Test",
		},
	];
	return doc;
}

it("copies kept sources once, preserves originals and hidden camera, and writes trimmed take timing", async () => {
	const doc = await fixture();
	const approved = vi.fn((file: string) => file);
	const result = await exportSourceHandoff(doc, root, approved);
	const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
	expect(result.sourceCount).toBe(2);
	expect(path.dirname(result.directory)).toBe(await fs.realpath(root));
	expect(approved).toHaveBeenCalledTimes(2);
	expect(await fs.readFile(path.join(result.directory, "001-screen.mp4"), "utf8")).toBe(
		"screen-original",
	);
	expect(await fs.readFile(doc.assets[0].originalPath, "utf8")).toBe("screen-original");
	expect(manifest.sources[0].camera).toMatchObject({
		offsetMs: -775,
		visibleInKlippt: false,
		file: "001-camera.mp4",
	});
	expect(manifest.clips).toMatchObject([
		{ sourceStartSec: 0, sourceEndSec: 2, timelineStartSec: 0, timelineEndSec: 2 },
		{ sourceStartSec: 4, sourceEndSec: 10, timelineStartSec: 2, timelineEndSec: 8 },
	]);
	expect(manifest.sources).toHaveLength(1);
	expect(manifest.timeline).toEqual({ file: "timeline.otio", frameRate: 60 });
	const timeline = JSON.parse(await fs.readFile(result.timelinePath, "utf8"));
	expect(
		timeline.tracks.children[0].children.map(
			(clip: { source_range: { start_time: { value: number } } }) =>
				clip.source_range.start_time.value,
		),
	).toEqual([0, 240]);
	const again = await exportSourceHandoff(doc, root, approved);
	expect(again.directory).not.toBe(result.directory);
});

it("does not validate removed spans that share a kept source", async () => {
	const doc = await fixture();
	doc.timeline.clips.push({
		...doc.timeline.clips[0],
		id: "removed",
		sourceStartSec: 20,
		sourceEndSec: 30,
		timelineStartSec: 10,
		timelineEndSec: 20,
	});
	doc.timeline.trimRanges.push({
		...doc.timeline.trimRanges[0],
		id: "all",
		clipId: "removed",
		startSec: 20,
		endSec: 30,
	});
	await expect(exportSourceHandoff(doc, root, (file) => file)).resolves.toHaveProperty(
		"timelinePath",
	);
});

it("cleans up a failed timeline when a camera duration is unreadable", async () => {
	const doc = await fixture();
	vi.mocked(inspectSourceAudioLayout)
		.mockResolvedValueOnce({
			hasAudio: false,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: 10,
		})
		.mockResolvedValueOnce({
			hasAudio: false,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: null,
		});
	await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow(
		"Could not read the duration",
	);
	expect((await fs.readdir(root)).sort()).toEqual(["camera.mp4", "screen.mp4"]);
});

it("rejects unapproved and symlinked sources before creating output", async () => {
	const doc = await fixture();
	const link = path.join(root, "linked.mp4");
	await fs.symlink(doc.assets[0].originalPath, link);
	doc.assets[0].originalPath = link;
	await expect(
		exportSourceHandoff(doc, root, (file) => (file === link ? file : null)),
	).rejects.toThrow("file picker");
	expect((await fs.readdir(root)).filter((name) => name.includes("-sources-"))).toEqual([]);
});

it("removes only its incomplete output when media preparation fails", async () => {
	const doc = await fixture();
	vi.mocked(inspectSourceAudioLayout).mockRejectedValueOnce(new Error("Unreadable recording"));
	await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow("Unreadable");
	expect((await fs.readdir(root)).sort()).toEqual(["camera.mp4", "screen.mp4"]);
});

it("omits fully removed takes and rejects an empty handoff", async () => {
	const doc = await fixture();
	doc.timeline.trimRanges[0].startSec = 0;
	doc.timeline.trimRanges[0].endSec = 10;
	await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow("no kept takes");
});

it("bounds provisional durations to the actual media length", async () => {
	const doc = await fixture();
	doc.timeline.clips[0].sourceEndSec = 60;
	doc.timeline.clips[0].timelineEndSec = 60;
	const result = await exportSourceHandoff(doc, root, (file) => file);
	const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
	expect(manifest.clips.at(-1).sourceEndSec).toBe(10);
	expect(manifest.clips.at(-1).timelineEndSec).toBe(8);
});

it("bounds provisional media before applying cuts that extend past its end", async () => {
	const doc = await fixture();
	doc.timeline.clips[0].sourceEndSec = 60;
	doc.timeline.clips[0].timelineEndSec = 60;
	doc.timeline.trimRanges[0].startSec = 5;
	doc.timeline.trimRanges[0].endSec = 20;
	const result = await exportSourceHandoff(doc, root, (file) => file);
	const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
	expect(manifest.clips).toMatchObject([{ sourceStartSec: 0, sourceEndSec: 5, timelineEndSec: 5 }]);
	expect(manifest.clips).toHaveLength(1);
});

it("reports an actionable destination failure without changing source media", async () => {
	const doc = await fixture();
	await expect(
		exportSourceHandoff(doc, path.join(root, "missing"), (file) => file),
	).rejects.toThrow("Choose a writable folder");
	expect(await fs.readFile(doc.assets[0].originalPath, "utf8")).toBe("screen-original");
});

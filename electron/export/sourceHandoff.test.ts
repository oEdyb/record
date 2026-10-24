import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { exportSourceHandoff } from "./sourceHandoff";
import { inspectHandoffSourceMedia } from "./sourceHandoffMedia";

vi.mock("./sourceHandoffMedia", () => ({ inspectHandoffSourceMedia: vi.fn() }));
vi.mock("../media/audioPeaks", () => ({ resolveFfmpeg: () => null, audioTrackMapArgs: () => [] }));
let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "source-handoff-test-"));
	vi.mocked(inspectHandoffSourceMedia)
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

async function exportedClips(timelinePath: string) {
	const timeline = JSON.parse(await fs.readFile(timelinePath, "utf8"));
	return timeline.tracks.children[0].children.map(
		(clip: {
			metadata: {
				klippt: {
					sourceStartSec: number;
					sourceEndSec: number;
					timelineStartSec: number;
					timelineEndSec: number;
				};
			};
		}) => clip.metadata.klippt,
	);
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
		visibleInKlippt: false,
		file: "001-camera.mp4",
	});
	expect(await exportedClips(result.timelinePath)).toMatchObject([
		{ sourceStartSec: 0, sourceEndSec: 2, timelineStartSec: 0, timelineEndSec: 2 },
		{ sourceStartSec: 4, sourceEndSec: 10, timelineStartSec: 2, timelineEndSec: 8 },
	]);
	expect(manifest).not.toHaveProperty("clips");
	expect(manifest.sources[0].camera).not.toHaveProperty("offsetMs");
	expect(manifest.sources[0].camera).not.toHaveProperty("startMs");
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

it("writes the clean cut as a second timeline with reason markers and leaves timeline.otio whole", async () => {
	const doc = await fixture();
	const result = await exportSourceHandoff(doc, root, (file) => file, {
		keep: [
			{ assetId: "a", startSec: 0, endSec: 1 },
			{ assetId: "a", startSec: 3, endSec: 6 },
			{ assetId: "a", startSec: 7, endSec: 9 },
		],
		markers: [{ keepIndex: 2, name: "Retake", comment: "said again later", color: "RED" }],
	});
	expect(result.cleanCutPath).toBe(path.join(result.directory, "timeline-clean-cut.otio"));
	expect(await exportedClips(result.cleanCutPath!)).toMatchObject([
		{ sourceStartSec: 0, sourceEndSec: 1, timelineStartSec: 0, timelineEndSec: 1 },
		{ sourceStartSec: 4, sourceEndSec: 6, timelineStartSec: 1, timelineEndSec: 3 },
		{ sourceStartSec: 7, sourceEndSec: 9, timelineStartSec: 3, timelineEndSec: 5 },
	]);
	const clean = JSON.parse(await fs.readFile(result.cleanCutPath!, "utf8"));
	expect(clean.name).toBe("../My take (clean cut)");
	expect(clean.tracks.children[0].children[2].markers).toMatchObject([
		{ name: "Retake", comment: "said again later", color: "RED" },
	]);
	expect(await exportedClips(result.timelinePath)).toHaveLength(2);
	const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
	expect(manifest.cleanCutTimeline).toEqual({ file: "timeline-clean-cut.otio" });
	expect(await fs.readFile(path.join(result.directory, "README.txt"), "utf8")).toContain(
		"timeline-clean-cut.otio",
	);
});

it("writes no clean cut timeline unless one is asked for", async () => {
	const result = await exportSourceHandoff(await fixture(), root, (file) => file);
	expect(result.cleanCutPath).toBeNull();
	await expect(fs.access(path.join(result.directory, "timeline-clean-cut.otio"))).rejects.toThrow();
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
	vi.mocked(inspectHandoffSourceMedia)
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
	vi.mocked(inspectHandoffSourceMedia).mockRejectedValueOnce(new Error("Unreadable recording"));
	await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow("Unreadable");
	expect((await fs.readdir(root)).sort()).toEqual(["camera.mp4", "screen.mp4"]);
});

it("omits fully removed takes and rejects an empty handoff", async () => {
	const doc = await fixture();
	doc.timeline.trimRanges[0].startSec = 0;
	doc.timeline.trimRanges[0].endSec = 10;
	await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow("no kept clips");
});

it("bounds provisional durations to the actual media length", async () => {
	const doc = await fixture();
	doc.timeline.clips[0].sourceEndSec = 60;
	doc.timeline.clips[0].timelineEndSec = 60;
	const result = await exportSourceHandoff(doc, root, (file) => file);
	const clips = await exportedClips(result.timelinePath);
	expect(clips.at(-1).sourceEndSec).toBe(10);
	expect(clips.at(-1).timelineEndSec).toBe(8);
});

it("bounds provisional media before applying cuts that extend past its end", async () => {
	const doc = await fixture();
	doc.timeline.clips[0].sourceEndSec = 60;
	doc.timeline.clips[0].timelineEndSec = 60;
	doc.timeline.trimRanges[0].startSec = 5;
	doc.timeline.trimRanges[0].endSec = 20;
	const result = await exportSourceHandoff(doc, root, (file) => file);
	const clips = await exportedClips(result.timelinePath);
	expect(clips).toMatchObject([{ sourceStartSec: 0, sourceEndSec: 5, timelineEndSec: 5 }]);
	expect(clips).toHaveLength(1);
});

it("reports an actionable destination failure without changing source media", async () => {
	const doc = await fixture();
	await expect(
		exportSourceHandoff(doc, path.join(root, "missing"), (file) => file),
	).rejects.toThrow("Choose a writable folder");
	expect(await fs.readFile(doc.assets[0].originalPath, "utf8")).toBe("screen-original");
});

it("byte-copies all four complete sources and stores their cuts and offsets only in OTIO", async () => {
	const doc = await fixture();
	const microphone = path.join(root, "microphone.m4a");
	const system = path.join(root, "system.m4a");
	await fs.writeFile(microphone, Buffer.from([0, 1, 2, 3, 255]));
	await fs.writeFile(system, Buffer.from([128, 32, 64, 16]));
	Object.assign(doc.assets[0], {
		microphoneAudioPath: microphone,
		systemAudioPath: system,
		microphoneAudioOffsetMs: 200,
		systemAudioOffsetMs: 100,
	});
	vi.mocked(inspectHandoffSourceMedia).mockImplementation(async (file) => ({
		hasAudio: file.endsWith(".m4a") || file.endsWith("screen.mp4"),
		hasKlipptMetadata: file.endsWith("screen.mp4"),
		roles: file.endsWith("screen.mp4") ? ["you", "system"] : [],
		durationSec: 10,
		...(file.endsWith(".mp4")
			? { video: { codec: "h264", width: 1920, height: 1080, fps: 60 } }
			: {}),
	}));
	const result = await exportSourceHandoff(doc, root, (file) => file);
	for (const [original, exported] of [
		[doc.assets[0].originalPath, "001-screen.mp4"],
		[doc.assets[0].cameraTrack!.sourcePath, "001-camera.mp4"],
		[microphone, "001-microphone.m4a"],
		[system, "001-system.m4a"],
	]) {
		expect(await fs.readFile(path.join(result.directory, exported))).toEqual(
			await fs.readFile(original),
		);
	}
	expect(result.sourceCount).toBe(4);
	expect(inspectHandoffSourceMedia).toHaveBeenCalledTimes(4);
	const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
	expect(manifest).toMatchObject({
		version: 2,
		mediaBytes: "unchanged",
		audioEncoding: "unchanged",
	});
	expect(manifest.sources[0].screen.audio).toEqual([
		{ role: "microphone", file: "001-microphone.m4a", durationSec: 10 },
		{ role: "system", file: "001-system.m4a", durationSec: 10 },
	]);
	expect(JSON.stringify(manifest)).not.toMatch(
		/Offset|offset|sourceStartSec|sourceEndSec|timelineStartSec/,
	);
	const timeline = JSON.parse(await fs.readFile(result.timelinePath, "utf8"));
	expect(timeline.tracks.children).toHaveLength(4);
	expect(timeline.tracks.children[2].children[0]).toMatchObject({
		OTIO_SCHEMA: "Gap.1",
		source_range: { duration: { value: 12 } },
	});
	expect(timeline.tracks.children[2].children[1]).toMatchObject({
		name: "001-microphone.m4a",
		metadata: { klippt: { sourceOffsetSec: 0.2 } },
	});
	expect(timeline.tracks.children[3].children[0]).toMatchObject({
		OTIO_SCHEMA: "Gap.1",
		source_range: { duration: { value: 6 } },
	});
});

it("retains original MKV and WebM containers even when their video could be remuxed", async () => {
	const doc = await fixture();
	const screen = path.join(root, "screen.mkv");
	const camera = path.join(root, "camera.webm");
	await fs.rename(doc.assets[0].originalPath, screen);
	await fs.rename(doc.assets[0].cameraTrack!.sourcePath, camera);
	doc.assets[0].originalPath = screen;
	doc.assets[0].cameraTrack!.sourcePath = camera;
	vi.mocked(inspectHandoffSourceMedia).mockResolvedValue({
		hasAudio: false,
		hasKlipptMetadata: false,
		roles: [],
		durationSec: 10,
		video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
	});
	const result = await exportSourceHandoff(doc, root, (file) => file);
	expect(await fs.readFile(path.join(result.directory, "001-screen.mkv"))).toEqual(
		await fs.readFile(screen),
	);
	expect(await fs.readFile(path.join(result.directory, "001-camera.webm"))).toEqual(
		await fs.readFile(camera),
	);
	expect(
		result.warnings.filter((warning) => warning.includes("original container retained")),
	).toHaveLength(2);
	expect((await fs.readdir(result.directory)).some((file) => file.endsWith(".mov"))).toBe(false);
});

it("keeps legacy embedded audio raw and discloses its unavailable standalone originals", async () => {
	const doc = await fixture();
	vi.mocked(inspectHandoffSourceMedia).mockResolvedValueOnce({
		hasAudio: true,
		hasKlipptMetadata: true,
		roles: ["you", "system"],
		durationSec: 10,
	});
	const result = await exportSourceHandoff(doc, root, (file) => file);
	expect(result.sourceCount).toBe(2);
	expect((await fs.readdir(result.directory)).filter((file) => /\.(wav|m4a)$/.test(file))).toEqual(
		[],
	);
	expect(result.warnings.join(" ")).toContain("it was not extracted");
	const timeline = JSON.parse(await fs.readFile(result.timelinePath, "utf8"));
	expect(timeline.tracks.children[2].children[0].OTIO_SCHEMA).toBe("Gap.1");
	expect(timeline.tracks.children[4].children[0].name).toBe("001-screen.mp4");
});

it("rejects a missing original audio file before publishing any source folder", async () => {
	const doc = await fixture();
	doc.assets[0].microphoneAudioPath = path.join(root, "missing.m4a");
	await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow(
		"Source file unavailable",
	);
	expect((await fs.readdir(root)).filter((file) => file.includes("-sources-"))).toEqual([]);
});

it("checks standalone audio isolation even when its path aliases an already copied video", async () => {
	const doc = await fixture();
	doc.assets[0].microphoneAudioPath = doc.assets[0].originalPath;
	vi.mocked(inspectHandoffSourceMedia).mockResolvedValueOnce({
		hasAudio: true,
		hasKlipptMetadata: true,
		roles: ["you"],
		durationSec: 10,
		video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
	});
	await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow(
		"not standalone audio",
	);
	expect((await fs.readdir(root)).sort()).toEqual(["camera.mp4", "screen.mp4"]);
});

it("refuses a copy that cannot fit before creating any source folder", async () => {
	const doc = await fixture();
	const statfs = vi.spyOn(fs, "statfs").mockResolvedValue({
		type: 0x1c,
		bsize: 4096,
		bavail: 1,
	} as Awaited<ReturnType<typeof fs.statfs>>);
	try {
		await expect(exportSourceHandoff(doc, root, (file) => file)).rejects.toThrow(
			"Not enough free space for the source files",
		);
		expect((await fs.readdir(root)).filter((name) => name.includes("-sources-"))).toEqual([]);
	} finally {
		statfs.mockRestore();
	}
});

// Real clones need macOS `cp -c`; elsewhere the platform-neutral refusal test covers the check.
it.runIf(process.platform === "darwin")(
	"needs no free space for clones on the same APFS volume",
	async () => {
		const doc = await fixture();
		const statfs = vi.spyOn(fs, "statfs").mockResolvedValue({
			type: 26,
			bsize: 4096,
			bavail: 0,
		} as Awaited<ReturnType<typeof fs.statfs>>);
		try {
			const result = await exportSourceHandoff(doc, root, (file) => file);
			expect(result.sourceCount).toBe(2);
		} finally {
			statfs.mockRestore();
		}
	},
);

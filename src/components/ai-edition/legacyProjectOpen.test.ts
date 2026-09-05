import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { fromKlipptMediaUrl } from "@/lib/localMediaUrl";
import { prepareLegacyProjectForOpen } from "./legacyProjectOpen";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai-edition/timeline/duration", () => ({ probeVideoDuration: probe }));

// The current CLI writes this legacy envelope without duration metadata.
const cliProject = {
	version: 2,
	media: {
		screenVideoPath: "/projects/gate2-soak/user-data/recordings/recording-clip-0001.mp4",
		cursorCaptureMode: "editable-overlay",
	},
	editor: {
		wallpaper: "/wallpapers/wallpaper1.jpg",
		trimRegions: [{ id: "trim", startMs: 1000, endMs: 2000 }],
	},
} as EditorProjectData;

describe("legacy GUI project opening", () => {
	beforeEach(() => probe.mockReset());

	it("completes a CLI clip before save without waiting for preview metadata", async () => {
		const original = JSON.stringify(cliProject);
		probe.mockResolvedValue(60.105875);
		const doc = await prepareLegacyProjectForOpen(cliProject);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(fromKlipptMediaUrl(probe.mock.calls[0][0])).toBe(cliProject.media?.screenVideoPath);
		expect(doc.project.title).toBe("recording-clip-0001");
		expect(doc.assets[0].durationSec).toBe(60.105875);
		expect(doc.timeline.clips[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 60.105875,
			timelineStartSec: 0,
			timelineEndSec: 60.105875,
		});
		expect(doc.timeline.trimRanges[0]).toMatchObject({
			clipId: doc.timeline.clips[0].id,
			startSec: 1,
			endSec: 2,
		});
		expect(JSON.stringify(cliProject)).toBe(original);
	});

	it("retains the recoverable placeholder when media is missing or not approved", async () => {
		probe.mockResolvedValue(null);
		const doc = await prepareLegacyProjectForOpen(cliProject);
		expect(doc.assets[0].originalPath).toBe(cliProject.media?.screenVideoPath);
		expect(doc.timeline.clips[0].sourceEndSec).toBeUndefined();
	});

	it("routes even a crafted URL through local media authorization", async () => {
		probe.mockResolvedValue(null);
		await prepareLegacyProjectForOpen({
			...cliProject,
			media: { screenVideoPath: "https://example.com/private.mp4" },
		});
		expect(probe.mock.calls[0][0]).toMatch(/^klippt:\/\/app\/__media__\//);
	});
});

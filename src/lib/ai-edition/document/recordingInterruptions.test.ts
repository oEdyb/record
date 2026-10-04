import { describe, expect, it } from "vitest";
import { normalizeRecordingSession } from "../../recordingSession";
import { createEmptyDocument, documentSchema } from "../schema";
import { recordingInterruptions, withRecordingInterruption } from "./recordingInterruptions";

describe("recording interruption persistence", () => {
	const interruption = { code: "writer-failed", message: "Recording stopped early." };
	it("keeps a valid interruption through session normalization and rejects malformed data", () => {
		const session = { screenVideoPath: "/screen.mp4", createdAt: 1, interruption };
		expect(normalizeRecordingSession(JSON.parse(JSON.stringify(session)))?.interruption).toEqual(
			interruption,
		);
		expect(
			normalizeRecordingSession({ ...session, interruption: { code: 2, message: [] } })
				?.interruption,
		).toBeUndefined();
	});
	it("survives project reopen and disappears when its recording leaves the timeline", () => {
		const document = createEmptyDocument({ projectId: "test", title: "Recording" });
		document.assets = [
			{
				id: "screen",
				kind: "video",
				label: "Screen",
				originalPath: "/screen.mp4",
				cameraTrack: null,
				recordingImportId: "recording-1",
			},
		];
		document.timeline.clips = [
			{
				id: "clip",
				assetId: "screen",
				sourceStartSec: 0,
				sourceEndSec: 2,
				timelineStartSec: 0,
				timelineEndSec: 2,
				wordRefs: [],
				origin: "system",
				reason: "recording",
			},
		];
		const saved = withRecordingInterruption(document, "recording-1", interruption);
		const reopened = documentSchema.parse(JSON.parse(JSON.stringify(saved)));
		expect(recordingInterruptions(reopened)).toEqual([interruption]);
		expect(
			recordingInterruptions({ ...reopened, timeline: { ...reopened.timeline, clips: [] } }),
		).toEqual([]);
		expect(recordingInterruptions(reopened)).toEqual([interruption]);
	});
});

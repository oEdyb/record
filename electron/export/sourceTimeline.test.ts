import { expect, it } from "vitest";
import { buildSourceTimeline, type HandoffSource, type HandoffSpan } from "./sourceTimeline";

const source: HandoffSource = {
	assetId: "a",
	screen: {
		file: "001-screen.mp4",
		durationSec: 10,
		audio: [
			{ role: "microphone", file: "001-microphone.wav", durationSec: 10 },
			{ role: "system", file: "001-system.wav", durationSec: 10 },
		],
	},
	camera: { file: "001-camera.mov", durationSec: 11, audio: [], startMs: 0, offsetMs: -775 },
};

function span(start = 0, end = 2, timelineStart = 0): HandoffSpan {
	return {
		id: `c-${start}`,
		assetId: "a",
		sourceStartSec: start,
		sourceEndSec: end,
		timelineStartSec: timelineStart,
		timelineEndSec: timelineStart + end - start,
	};
}

it("places original standalone audio on audio tracks and preserves cuts on all four tracks", () => {
	const { timeline, warnings } = buildSourceTimeline("Test", [source], [span(), span(4, 10, 2)]);
	const tracks = timeline.tracks.children;
	expect(tracks.map((track) => [track.name, track.kind])).toEqual([
		["Screen", "Video"],
		["Camera", "Video"],
		["Microphone", "Audio"],
		["System audio", "Audio"],
	]);
	expect(warnings).toEqual([]);
	for (const [index, track] of tracks.entries()) {
		expect(track.children.map((child) => child.source_range.duration.value)).toEqual([120, 360]);
		expect(track.children.map((child) => child.source_range.start_time.value)).toEqual(
			index === 1 ? [47, 287] : [0, 240],
		);
		for (const child of track.children) {
			expect(child.OTIO_SCHEMA).toBe("Clip.2");
			if ("media_references" in child) {
				const url = child.media_references.DEFAULT_MEDIA.target_url;
				expect(url).not.toContain("/");
				if (index >= 2) expect(url).toMatch(/\.wav$/);
			}
		}
	}
});

it("applies each original audio start delay once and preserves later cuts and short tails", () => {
	const delayed: HandoffSource = {
		...source,
		screen: {
			...source.screen,
			audio: [
				{ role: "microphone", file: "mic.m4a", durationSec: 2, offsetSec: 0.2 },
				{ role: "system", file: "system.m4a", durationSec: 0.5, offsetSec: 0.1 },
			],
		},
	};
	const tracks = buildSourceTimeline("Delayed", [delayed], [span(0, 1), span(2, 3, 1)]).timeline
		.tracks.children;
	expect(
		tracks[2].children.map((child) => [
			child.OTIO_SCHEMA,
			child.source_range.start_time.value,
			child.source_range.duration.value,
		]),
	).toEqual([
		["Gap.1", 0, 12],
		["Clip.2", 0, 48],
		["Clip.2", 108, 12],
		["Gap.1", 0, 48],
	]);
	expect(
		tracks[3].children.map((child) => [
			child.OTIO_SCHEMA,
			child.source_range.start_time.value,
			child.source_range.duration.value,
		]),
	).toEqual([
		["Gap.1", 0, 6],
		["Clip.2", 0, 30],
		["Gap.1", 0, 24],
		["Gap.1", 0, 60],
	]);
	const kept = tracks[2].children[2];
	expect(kept).toMatchObject({
		metadata: {
			klippt: {
				sourceStartSec: 2,
				sourceEndSec: 3,
				timelineStartSec: 1,
				timelineEndSec: 2,
				sourceOffsetSec: 0.2,
			},
		},
	});
});

it("keeps late camera starts, short camera tails, and missing takes as gaps", () => {
	const late = {
		...source,
		camera: { ...source.camera!, durationSec: 1, startMs: 400, offsetMs: 100 },
	};
	const missing: HandoffSource = { ...source, assetId: "b", camera: null };
	const result = buildSourceTimeline(
		"Gaps",
		[late, missing],
		[span(), { ...span(0, 2, 2), assetId: "b" }],
	);
	expect(
		result.timeline.tracks.children[1].children.map((child) => [
			child.OTIO_SCHEMA,
			child.source_range.start_time.value,
			child.source_range.duration.value,
		]),
	).toEqual([
		["Gap.1", 0, 30],
		["Clip.2", 0, 60],
		["Gap.1", 0, 30],
		["Gap.1", 0, 120],
	]);
	expect(result.warnings).toHaveLength(1);
});

it("pads writer tails with silent one-frame gaps and warns only about real losses", () => {
	const tails: HandoffSource = {
		...source,
		screen: {
			...source.screen,
			durationSec: 48.757,
			audio: [
				{ role: "microphone", file: "mic.m4a", durationSec: 48.74, offsetSec: 0.009 },
				{ role: "system", file: "system.m4a", durationSec: 48.7, offsetSec: 0.018 },
			],
		},
		camera: { ...source.camera!, durationSec: 40.5, startMs: 0, offsetMs: 0 },
	};
	const result = buildSourceTimeline("Tails", [tails], [span(0, 48.757)]);
	const kinds = (index: number) =>
		result.timeline.tracks.children[index].children.map((child) => child.OTIO_SCHEMA);
	expect(kinds(2)).toEqual(["Gap.1", "Clip.2"]);
	expect(kinds(3)).toEqual(["Gap.1", "Clip.2", "Gap.1"]);
	expect(kinds(1)).toEqual(["Clip.2", "Gap.1"]);
	expect(result.warnings).toEqual([
		"001-camera.mov: 8.3 s of source time is missing and left as a gap in the timelines.",
	]);
});

it("bounds short audio independently and keeps unidentified audio separate", () => {
	const short: HandoffSource = {
		...source,
		screen: {
			...source.screen,
			audio: [
				{ role: "microphone", file: "mic.wav", durationSec: 0.5 },
				{ role: "audio", file: "old.wav", durationSec: 2 },
			],
		},
	};
	const tracks = buildSourceTimeline("Audio", [short], [span()]).timeline.tracks.children;
	expect(
		tracks[2].children.map((child) => [child.OTIO_SCHEMA, child.source_range.duration.value]),
	).toEqual([
		["Clip.2", 30],
		["Gap.1", 90],
	]);
	expect(tracks[3].children[0].OTIO_SCHEMA).toBe("Gap.1");
	expect(tracks[4].name).toBe("Original audio (unidentified)");
	expect(tracks[4].children[0].name).toBe("old.wav");
});

it("rounds cumulative boundaries without a frame of drift for each fractional cut", () => {
	const spans = Array.from({ length: 100 }, (_, index) => span(0, 0.025, index * 0.025));
	const { timeline } = buildSourceTimeline("Fractional", [source], spans);
	for (const track of timeline.tracks.children) {
		expect(track.children.reduce((sum, child) => sum + child.source_range.duration.value, 0)).toBe(
			150,
		);
	}
});

it("does not create a one-frame gap for an ordinary fractional media duration", () => {
	const fractional = { ...source, screen: { ...source.screen, durationSec: 1.08 } };
	const { timeline, warnings } = buildSourceTimeline("End", [fractional], [span(0, 1.08)]);
	expect(timeline.tracks.children[0].children).toHaveLength(1);
	expect(timeline.tracks.children[0].children[0].source_range.duration.value).toBe(65);
	expect(warnings).toEqual([]);
});

it("reports sub-frame omissions and rejects unknown media duration", () => {
	expect(() => buildSourceTimeline("Empty", [source], [span(0, 0.001)])).toThrow(
		"shorter than one timeline frame",
	);
	expect(
		buildSourceTimeline("Short", [source], [span(0, 0.001), span(1, 2, 0.001)]).warnings,
	).toEqual(["A kept span shorter than one timeline frame was omitted from the timelines."]);
	expect(() =>
		buildSourceTimeline(
			"Unknown",
			[{ ...source, screen: { ...source.screen, durationSec: null } }],
			[span()],
		),
	).toThrow("Could not read the duration");
	expect(() => buildSourceTimeline("Missing", [], [span()])).toThrow("Missing timeline source");
});

it("puts each marker on the microphone clip that plays at its timeline time, in that clip's media time", () => {
	const { timeline } = buildSourceTimeline(
		"Test",
		[source],
		[span(), span(4, 10, 2)],
		[
			{ timelineSec: 2, name: "Retake", comment: "said again", color: "RED" },
			{ timelineSec: 3.5, name: "Stutter", comment: "", color: "CYAN" },
		],
	);
	const [screen, , microphone] = timeline.tracks.children;
	const marked = microphone.children.map((child) =>
		"markers" in child ? child.markers.map((m) => [m.name, m.marked_range.start_time.value]) : [],
	);
	expect(marked).toEqual([
		[],
		[
			["Retake", 240],
			["Stutter", 330],
		],
	]);
	expect(screen.children.every((child) => child.markers.length === 0)).toBe(true);
	const retake = microphone.children[1] as { markers: { metadata: unknown }[] };
	expect(retake.markers[0]?.metadata).toEqual({
		Resolve_OTIO: { Keywords: [], Note: "said again" },
	});
});

it("hosts markers on the screen clip when there is no microphone original", () => {
	const silent: HandoffSource = { ...source, screen: { ...source.screen, audio: [] } };
	const { timeline } = buildSourceTimeline(
		"Test",
		[silent],
		[span()],
		[{ timelineSec: 1, name: "Filler", comment: "", color: "GREEN" }],
	);
	const screen = timeline.tracks.children[0];
	expect(screen.children[0]?.markers.map((m) => m.marked_range.start_time.value)).toEqual([60]);
});

it("keeps marker source time after audio gaps, offsets and cuts in the shared frame plan", () => {
	const delayed: HandoffSource = {
		...source,
		screen: {
			...source.screen,
			audio: [{ role: "microphone", file: "mic.wav", durationSec: 10, offsetSec: 0.2 }],
		},
	};
	const { timeline, plan } = buildSourceTimeline(
		"Delayed markers",
		[delayed],
		[span(), span(4, 6, 2)],
		[
			{ timelineSec: 0.1, name: "In gap", comment: "", color: "RED" },
			{ timelineSec: 0.2, name: "At audio start", comment: "", color: "GREEN" },
			{ timelineSec: 2.5, name: "After cut", comment: "source note", color: "BLUE" },
			{ timelineSec: 4, name: "Past end", comment: "", color: "RED" },
		],
	);
	const microphone = timeline.tracks.children[2];
	expect(microphone.children.flatMap((child) => child.markers)).toMatchObject([
		{ name: "At audio start", marked_range: { start_time: { value: 0 } } },
		{ name: "After cut", marked_range: { start_time: { value: 258 } } },
	]);
	expect(plan.tracks[2].items).toMatchObject([
		{ type: "gap", duration: 12 },
		{ type: "clip", start: 0, duration: 108 },
		{ type: "clip", start: 228, duration: 120 },
	]);
});

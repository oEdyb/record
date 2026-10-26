import { describe, expect, it } from "vitest";
import {
	buildSourceTimeline,
	type HandoffSource,
	type HandoffSpan,
	planSourceTimeline,
} from "./sourceTimeline";
import { buildSourceFcpxml, type FcpxmlMediaInfo, fcpxmlTime } from "./sourceTimelineFcpxml";

const source: HandoffSource = {
	assetId: "a",
	screen: {
		file: "001-screen.mov",
		durationSec: 10,
		audio: [
			{ role: "microphone", file: "001-microphone.wav", durationSec: 10 },
			{ role: "system", file: "001-system.wav", durationSec: 10 },
		],
	},
	camera: { file: "001-camera.mov", durationSec: 11, audio: [], startMs: 0, offsetMs: -775 },
};

const media = new Map<string, FcpxmlMediaInfo>([
	["001-screen.mov", { hasVideo: true, hasAudio: true }],
	["001-camera.mov", { hasVideo: true, hasAudio: false }],
	["001-microphone.wav", { hasVideo: false, hasAudio: true }],
	["001-system.wav", { hasVideo: false, hasAudio: true }],
]);

function span(start = 0, end = 2, timelineStart = 0, assetId = "a"): HandoffSpan {
	return {
		id: `c-${start}`,
		assetId,
		sourceStartSec: start,
		sourceEndSec: end,
		timelineStartSec: timelineStart,
		timelineEndSec: timelineStart + end - start,
	};
}

function frames(value: string) {
	const match = /^(\d+)(?:\/(\d+))?s$/.exec(value);
	if (!match) throw new Error(`Not an FCPXML time: ${value}`);
	return (Number(match[1]) * 60) / Number(match[2] ?? 1);
}

function attributes(tag: string) {
	return Object.fromEntries([...tag.matchAll(/ (\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

interface Placed {
	file: string;
	lane: number;
	at: number;
	start: number;
	duration: number;
	srcEnable: string;
	audioRole?: string;
}

/** Resolves every spine and connected clip to its absolute timeline frame. */
function placements(xml: string) {
	const spine = /<spine>(.*)<\/spine>/s.exec(xml)![1];
	const placed: Placed[] = [];
	const pieces = [...spine.matchAll(/<(asset-clip|gap)( [^>]*?)(\/>|>(.*?)<\/\1>)/gs)];
	for (const piece of pieces) {
		const parent = attributes(piece[2]);
		const parentAt = frames(parent.offset);
		const parentStart = frames(parent.start);
		if (piece[1] === "asset-clip")
			placed.push({
				file: parent.name,
				lane: 0,
				at: parentAt,
				start: parentStart,
				duration: frames(parent.duration),
				srcEnable: parent.srcEnable,
			});
		for (const child of (piece[4] ?? "").matchAll(/<asset-clip( [^>]*)\/>/g)) {
			const attrs = attributes(child[1]);
			placed.push({
				file: attrs.name,
				lane: Number(attrs.lane),
				at: parentAt + frames(attrs.offset) - parentStart,
				start: frames(attrs.start),
				duration: frames(attrs.duration),
				srcEnable: attrs.srcEnable,
				audioRole: attrs.audioRole,
			});
		}
	}
	return { pieces: pieces.map((piece) => piece[1]), placed };
}

function planned(sources: HandoffSource[], spans: HandoffSpan[]) {
	const lanes = { screen: 0, camera: 1, microphone: -1, system: -2, audio: -3 };
	const result: Array<Pick<Placed, "file" | "lane" | "at" | "start" | "duration">> = [];
	for (const track of planSourceTimeline(sources, spans).tracks) {
		let at = 0;
		for (const item of track.items) {
			if (item.type === "clip")
				result.push({
					file: item.file,
					lane: lanes[track.role],
					at,
					start: item.start,
					duration: item.duration,
				});
			at += item.duration;
		}
	}
	return result;
}

function build(sources: HandoffSource[], spans: HandoffSpan[], title = "Take") {
	return buildSourceFcpxml(title, planSourceTimeline(sources, spans).tracks, {
		width: 3024,
		height: 1964,
		media,
	});
}

function sorted(items: Array<Pick<Placed, "file" | "lane" | "at" | "start" | "duration">>) {
	return items
		.map(({ file, lane, at, start, duration }) => ({ file, lane, at, start, duration }))
		.sort((a, b) => a.lane - b.lane || a.at - b.at);
}

describe("fcpxmlTime", () => {
	it("writes whole timeline frames as reduced rational seconds", () => {
		expect(fcpxmlTime(0)).toBe("0s");
		expect(fcpxmlTime(1)).toBe("1/60s");
		expect(fcpxmlTime(47)).toBe("47/60s");
		expect(fcpxmlTime(60)).toBe("1s");
		expect(fcpxmlTime(90)).toBe("3/2s");
		expect(fcpxmlTime(125)).toBe("25/12s");
		expect(fcpxmlTime(216_000)).toBe("3600s");
	});

	it("rejects sub-frame and negative values instead of rounding them", () => {
		expect(() => fcpxmlTime(1.5)).toThrow("Invalid timeline frame");
		expect(() => fcpxmlTime(-1)).toThrow("Invalid timeline frame");
	});
});

it("places the same cuts and camera sync as timeline.otio on lanes around the screen storyline", () => {
	const spans = [span(), span(4, 10, 2)];
	const xml = build([source], spans);
	const { pieces, placed } = placements(xml);
	expect(pieces).toEqual(["asset-clip", "asset-clip"]);
	expect(sorted(placed)).toEqual(sorted(planned([source], spans)));
	expect(placed.filter((clip) => clip.lane === 1).map((clip) => [clip.at, clip.start])).toEqual([
		[0, 47],
		[120, 287],
	]);
	expect(placed.find((clip) => clip.lane === 0)).toMatchObject({ srcEnable: "video" });
	expect(placed.find((clip) => clip.lane === 1)).toMatchObject({ srcEnable: "video" });
	expect(placed.find((clip) => clip.lane === -1)).toMatchObject({
		srcEnable: "audio",
		audioRole: "dialogue",
	});
	expect(placed.find((clip) => clip.lane === -2)).toMatchObject({
		srcEnable: "audio",
		audioRole: "effects",
	});
	expect(xml).toContain('<sequence format="r1" duration="8s"');
	expect(xml).toContain('<format id="r1" frameDuration="1/60s" width="3024" height="1964"');
	expect(xml).toContain('<media-rep kind="original-media" src="./001-screen.mov"/>');
	expect(xml).toMatch(
		/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">/,
	);
});

it("anchors late and short sources to the spine piece that contains their first frame", () => {
	const late: HandoffSource = {
		...source,
		screen: { ...source.screen, durationSec: 1.5 },
		camera: { ...source.camera!, durationSec: 1, startMs: 400, offsetMs: 100 },
	};
	const missing: HandoffSource = { ...source, assetId: "b", camera: null };
	const spans = [span(), span(0, 2, 2, "b")];
	const xml = build([late, missing], spans);
	const { pieces, placed } = placements(xml);
	expect(pieces).toEqual(["asset-clip", "gap", "asset-clip"]);
	expect(sorted(placed)).toEqual(sorted(planned([late, missing], spans)));
	expect(xml).toContain('<gap name="Gap" offset="3/2s" start="0s" duration="1/2s"');
});

it("anchors a source that starts after a short screen tail to the spine gap", () => {
	const tail: HandoffSource = {
		...source,
		screen: { ...source.screen, durationSec: 1 },
		camera: { ...source.camera!, durationSec: 5, startMs: 1500, offsetMs: 0 },
	};
	const xml = build([tail], [span()]);
	const { pieces, placed } = placements(xml);
	expect(pieces).toEqual(["asset-clip", "gap"]);
	expect(sorted(placed)).toEqual(sorted(planned([tail], [span()])));
	expect(xml).toContain(
		'<gap name="Gap" offset="1s" start="0s" duration="1s"><asset-clip ref="r4" lane="1" offset="1/2s" name="001-camera.mov" start="0s" duration="1/2s" srcEnable="video"/></gap>',
	);
});

it("keeps unidentified embedded audio on its own lane from the same screen asset", () => {
	const legacy: HandoffSource = {
		...source,
		camera: null,
		screen: {
			...source.screen,
			audio: [{ role: "audio", file: "001-screen.mov", durationSec: 10 }],
		},
	};
	const xml = build([legacy], [span()]);
	const { placed } = placements(xml);
	expect(placed.filter((clip) => clip.file === "001-screen.mov")).toMatchObject([
		{ lane: 0, srcEnable: "video" },
		{ lane: -3, srcEnable: "audio", audioRole: undefined },
	]);
	expect(xml.match(/<asset /g)).toHaveLength(1);
	expect(xml).not.toContain("FFFrameRateUndefined");
});

it("gives audio-only assets the undefined frame-rate format", () => {
	const xml = build([source], [span()]);
	expect(xml).toContain('<format id="r2" name="FFFrameRateUndefined"/>');
	expect(xml).toMatch(
		/<asset id="r\d+" name="001-microphone.wav" start="0s" duration="10s" hasVideo="0" format="r2" hasAudio="1">/,
	);
	expect(xml).toMatch(
		/<asset id="r\d+" name="001-screen.mov" start="0s" duration="10s" hasVideo="1" hasAudio="1">/,
	);
});

it("keeps cumulative fractional cuts on the frame grid without drift", () => {
	const spans = Array.from({ length: 100 }, (_, index) => span(0, 0.025, index * 0.025));
	const xml = build([source], spans);
	const { placed } = placements(xml);
	expect(xml).toContain('duration="5/2s"');
	const screen = placed.filter((clip) => clip.lane === 0);
	expect(screen.reduce((sum, clip) => sum + clip.duration, 0)).toBe(150);
	for (const [index, clip] of screen.entries())
		if (index) expect(clip.at).toBe(screen[index - 1].at + screen[index - 1].duration);
	const otio = buildSourceTimeline("Fractional", [source], spans).timeline.tracks.children[0];
	expect(screen.map((clip) => clip.duration)).toEqual(
		otio.children.map((child) => child.source_range.duration.value),
	);
});

it("escapes titles and file names", () => {
	const odd: HandoffSource = {
		...source,
		camera: null,
		screen: { ...source.screen, file: "001 screen & co.mov", audio: [] },
	};
	const xml = build([odd], [span()], `Tom & "Jerry" <take>\u0007\uFFFF`);
	expect(xml).toContain('<event name="Tom &amp; &quot;Jerry&quot; &lt;take&gt;">');
	expect(xml).toContain('name="001 screen &amp; co.mov"');
	expect(xml).toContain('src="./001%20screen%20%26%20co.mov"');
});

import {
	clipProvenance,
	type PlannedItem,
	type PlannedTrack,
	SOURCE_TIMELINE_RATE,
	type SourceTrackRole,
} from "./sourceTimeline";

export const FCPXML_VERSION = "1.10";

export interface FcpxmlMediaInfo {
	hasVideo: boolean;
	hasAudio: boolean;
}

export interface FcpxmlOptions {
	width: number;
	height: number;
	media: ReadonlyMap<string, FcpxmlMediaInfo>;
}

const LANES: Record<Exclude<SourceTrackRole, "screen">, number> = {
	camera: 1,
	microphone: -1,
	system: -2,
	audio: -3,
};

const AUDIO_ROLES: Partial<Record<SourceTrackRole, string>> = {
	microphone: "dialogue",
	system: "effects",
};

function gcd(a: number, b: number): number {
	return b ? gcd(b, a % b) : a;
}

/** Rational seconds for a whole number of timeline frames, e.g. 90 frames -> "3/2s". */
export function fcpxmlTime(frames: number): string {
	if (!Number.isInteger(frames) || frames < 0) throw new Error(`Invalid timeline frame: ${frames}`);
	const divisor = gcd(frames, SOURCE_TIMELINE_RATE) || SOURCE_TIMELINE_RATE;
	const numerator = frames / divisor;
	const denominator = SOURCE_TIMELINE_RATE / divisor;
	return denominator === 1 ? `${numerator}s` : `${numerator}/${denominator}s`;
}

const INVALID_XML_CHARACTERS = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

function escapeXml(value: string): string {
	return value
		.replace(INVALID_XML_CHARACTERS, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function element(name: string, attributes: Record<string, string | undefined>, children = "") {
	const attrs = Object.entries(attributes)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
		.join("");
	return children ? `<${name}${attrs}>${children}</${name}>` : `<${name}${attrs}/>`;
}

interface Placed extends Omit<Extract<PlannedItem, { type: "clip" }>, "type"> {
	role: SourceTrackRole;
	at: number;
	file: string;
	start: number;
	duration: number;
}

/** Final Cut Pro timeline of the same frame-grid plan that `timeline.otio` serializes. */
export function buildSourceFcpxml(title: string, tracks: PlannedTrack[], options: FcpxmlOptions) {
	const assets = new Map<string, { id: string; available: number; info: FcpxmlMediaInfo }>();
	const clips: Placed[] = [];
	let total = 0;
	for (const track of tracks) {
		let at = 0;
		for (const item of track.items) {
			if (item.type === "clip") {
				const info = options.media.get(item.file) ?? {
					hasVideo: track.kind === "Video",
					hasAudio: track.kind === "Audio",
				};
				const asset = assets.get(item.file);
				if (asset) asset.available = Math.max(asset.available, item.available);
				else assets.set(item.file, { id: `r${assets.size + 3}`, available: item.available, info });
				clips.push({ role: track.role, at, ...item });
			}
			at += item.duration;
		}
		total = Math.max(total, at);
	}
	const screen = tracks.find((track) => track.role === "screen");
	if (!screen) throw new Error("The source timeline has no screen track.");
	const anchored = clips.filter((clip) => clip.role !== "screen");
	const clipAttributes = (clip: Placed, offset: number) => {
		const role = clip.role;
		const isAudio = role === "microphone" || role === "system" || role === "audio";
		return {
			ref: assets.get(clip.file)!.id,
			lane: role === "screen" ? undefined : String(LANES[role]),
			offset: fcpxmlTime(offset),
			name: clipProvenance({ type: "clip", ...clip }, role, clip.at).name,
			start: fcpxmlTime(clip.start),
			duration: fcpxmlTime(clip.duration),
			srcEnable: isAudio ? "audio" : "video",
			audioRole: AUDIO_ROLES[role],
		};
	};
	let at = 0;
	const spine = screen.items
		.map((item) => {
			const begin = at;
			const end = begin + item.duration;
			at = end;
			const local = item.type === "clip" ? item.start : 0;
			const children = anchored
				.filter((clip) => clip.at >= begin && clip.at < end)
				.map((clip) => element("asset-clip", clipAttributes(clip, local + clip.at - begin)))
				.join("");
			return item.type === "clip"
				? element(
						"asset-clip",
						clipAttributes({ role: "screen", at: begin, ...item }, begin),
						children,
					)
				: element(
						"gap",
						{
							name: "Gap",
							offset: fcpxmlTime(begin),
							start: fcpxmlTime(0),
							duration: fcpxmlTime(item.duration),
						},
						children,
					);
		})
		.join("");
	const hasAudioOnly = [...assets.values()].some((asset) => !asset.info.hasVideo);
	const resources = [
		element("format", {
			id: "r1",
			frameDuration: fcpxmlTime(1),
			width: String(options.width),
			height: String(options.height),
			colorSpace: "1-1-1 (Rec. 709)",
		}),
		hasAudioOnly ? element("format", { id: "r2", name: "FFFrameRateUndefined" }) : "",
		...[...assets].map(([file, asset]) =>
			element(
				"asset",
				{
					id: asset.id,
					name: file,
					start: "0s",
					duration: fcpxmlTime(asset.available),
					hasVideo: asset.info.hasVideo ? "1" : "0",
					format: asset.info.hasVideo ? undefined : "r2",
					hasAudio: asset.info.hasAudio ? "1" : "0",
				},
				element("media-rep", { kind: "original-media", src: `./${encodeURIComponent(file)}` }),
			),
		),
	].join("");
	const sequence = element(
		"sequence",
		{
			format: "r1",
			duration: fcpxmlTime(total),
			tcStart: "0s",
			tcFormat: "NDF",
			audioLayout: "stereo",
			audioRate: "48k",
		},
		element("spine", {}, spine),
	);
	const body = element(
		"fcpxml",
		{ version: FCPXML_VERSION },
		element("resources", {}, resources) +
			element("event", { name: title }, element("project", { name: title }, sequence)),
	);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${body}\n`;
}

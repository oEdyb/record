export interface HandoffMedia {
	file: string;
	durationSec: number | null;
	audio: Array<{ role: string; file: string; durationSec?: number | null; offsetSec?: number }>;
}

export interface HandoffSource {
	assetId: string;
	screen: HandoffMedia;
	camera: (HandoffMedia & { startMs: number; offsetMs: number }) | null;
}

export interface HandoffSpan {
	id: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec?: number;
	timelineStartSec: number;
	timelineEndSec: number;
}

export type MarkerColor =
	| "RED"
	| "ORANGE"
	| "YELLOW"
	| "GREEN"
	| "CYAN"
	| "BLUE"
	| "PURPLE"
	| "PINK";

export interface TimelineMarker {
	timelineSec: number;
	name: string;
	comment: string;
	color: MarkerColor;
}

export const SOURCE_TIMELINE_RATE = 60;
/**
 * Separate writers end a few frames apart: audio flushes its last buffer and the camera
 * stops with the screen, so every original is tens of milliseconds shorter than the screen.
 * Those sub-tenth-second shortfalls become honest one-frame gaps in the timeline but are
 * not worth a warning; a real loss, like a camera that dropped out, is.
 */
export const SOURCE_GAP_WARNING_SEC = 0.1;

function time(value: number) {
	return { OTIO_SCHEMA: "RationalTime.1", value, rate: SOURCE_TIMELINE_RATE };
}

function range(start: number, duration: number) {
	return { OTIO_SCHEMA: "TimeRange.1", start_time: time(start), duration: time(duration) };
}

function gap(duration: number) {
	return {
		OTIO_SCHEMA: "Gap.1",
		name: "",
		source_range: range(0, duration),
		effects: [],
		markers: [],
		metadata: {},
	};
}

function marker(entry: TimelineMarker, mediaFrame: number) {
	return {
		OTIO_SCHEMA: "Marker.2",
		name: entry.name,
		marked_range: range(mediaFrame, 1),
		color: entry.color,
		comment: entry.comment,
		// DaVinci Resolve ignores `comment` and reads the marker note from its own metadata.
		metadata: { Resolve_OTIO: { Keywords: [], Note: entry.comment } },
	};
}

function clip(
	file: string,
	start: number,
	duration: number,
	available: number,
	span: HandoffSpan,
	offsetSec: number,
) {
	return {
		OTIO_SCHEMA: "Clip.2",
		name: file,
		source_range: range(start, duration),
		media_references: {
			DEFAULT_MEDIA: {
				OTIO_SCHEMA: "ExternalReference.1",
				target_url: file,
				available_range: range(0, available),
				metadata: {},
			},
		},
		active_media_reference_key: "DEFAULT_MEDIA",
		effects: [],
		markers: [] as ReturnType<typeof marker>[],
		metadata: {
			klippt: {
				clipId: span.id,
				assetId: span.assetId,
				sourceStartSec: span.sourceStartSec,
				sourceEndSec: span.sourceEndSec,
				timelineStartSec: span.timelineStartSec,
				timelineEndSec: span.timelineEndSec,
				sourceOffsetSec: offsetSec,
			},
		},
	};
}

type Item = ReturnType<typeof gap> | ReturnType<typeof clip>;
type TrackSource = { file: string; durationSec: number | null; offsetSec: number };

/** Markers sit on the clips of one host track, in that clip's media time, the way Resolve reads them. */
export function buildSourceTimeline(
	title: string,
	sources: HandoffSource[],
	spans: HandoffSpan[],
	markers: TimelineMarker[] = [],
) {
	const sourceById = new Map(sources.map((source) => [source.assetId, source]));
	const frame = (sec: number) => Math.round(sec * SOURCE_TIMELINE_RATE + 1e-8);
	if (!spans.some((span) => frame(span.timelineEndSec) > frame(span.timelineStartSec)))
		throw new Error(
			"The kept edit is shorter than one timeline frame. Keep a longer span to export.",
		);
	const warnings = new Set<string>();
	const markerFrames = markers.map((entry) => ({ entry, frame: frame(entry.timelineSec) }));
	const track = (
		name: string,
		kind: "Video" | "Audio",
		select: (source: HandoffSource) => TrackSource | undefined,
		hostsMarkers = false,
	) => {
		const children: Item[] = [];
		let position = 0;
		for (const span of spans) {
			const duration = frame(span.timelineEndSec) - frame(span.timelineStartSec);
			if (duration <= 0) {
				warnings.add("A kept span shorter than one timeline frame was omitted from timeline.otio.");
				continue;
			}
			const source = sourceById.get(span.assetId);
			if (!source) throw new Error(`Missing timeline source: ${span.assetId}`);
			const media = select(source);
			if (!media) {
				children.push(gap(duration));
				position += duration;
				continue;
			}
			if (media.durationSec === null || !Number.isFinite(media.durationSec)) {
				throw new Error(
					`Could not read the duration of ${media.file}. Relink it before exporting.`,
				);
			}
			const available = frame(media.durationSec);
			const start = frame(span.sourceStartSec - media.offsetSec);
			const lead = Math.min(duration, Math.max(0, -start));
			const sourceStart = Math.max(0, start);
			const length = Math.max(0, Math.min(duration - lead, available - sourceStart));
			if (lead) children.push(gap(lead));
			if (length) {
				const piece = clip(media.file, sourceStart, length, available, span, media.offsetSec);
				const from = position + lead;
				if (hostsMarkers)
					for (const { entry, frame: at } of markerFrames)
						if (at >= from && at < from + length)
							piece.markers.push(marker(entry, sourceStart + at - from));
				children.push(piece);
			}
			if (duration > lead + length) children.push(gap(duration - lead - length));
			position += duration;
			const missingSec = (duration - length) / SOURCE_TIMELINE_RATE;
			if (missingSec > SOURCE_GAP_WARNING_SEC)
				warnings.add(
					`${media.file}: ${missingSec.toFixed(1)} s of source time is missing and left as a gap in timeline.otio.`,
				);
		}
		return {
			OTIO_SCHEMA: "Track.1",
			name,
			kind,
			children,
			source_range: null,
			effects: [],
			markers: [],
			metadata: {},
		};
	};
	const audio = (role: string) => (source: HandoffSource) => {
		const media = source.screen.audio.find((item) => item.role === role);
		return media
			? {
					file: media.file,
					durationSec:
						media.durationSec === undefined ? source.screen.durationSec : media.durationSec,
					offsetSec: media.offsetSec ?? 0,
				}
			: undefined;
	};
	const micHostsMarkers = sources.some((source) =>
		source.screen.audio.some((item) => item.role === "microphone"),
	);
	const tracks = [
		track("Screen", "Video", (source) => ({ ...source.screen, offsetSec: 0 }), !micHostsMarkers),
		track("Camera", "Video", (source) =>
			source.camera
				? { ...source.camera, offsetSec: (source.camera.startMs + source.camera.offsetMs) / 1000 }
				: undefined,
		),
		track("Microphone", "Audio", audio("microphone"), micHostsMarkers),
		track("System audio", "Audio", audio("system")),
	];
	if (sources.some((source) => source.screen.audio.some((item) => item.role === "audio")))
		tracks.push(track("Original audio (unidentified)", "Audio", audio("audio")));
	return {
		timeline: {
			OTIO_SCHEMA: "Timeline.1",
			name: title,
			global_start_time: time(0),
			metadata: { klippt: { version: 1, frameRate: SOURCE_TIMELINE_RATE } },
			tracks: {
				OTIO_SCHEMA: "Stack.1",
				name: "Tracks",
				children: tracks,
				source_range: null,
				effects: [],
				markers: [],
				metadata: {},
			},
		},
		warnings: [...warnings],
	};
}

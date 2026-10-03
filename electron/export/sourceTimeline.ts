export interface HandoffMedia {
	file: string;
	durationSec: number | null;
	audio: Array<{ role: string; file: string; durationSec?: number | null }>;
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

export const SOURCE_TIMELINE_RATE = 60;

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

function clip(file: string, start: number, duration: number, available: number, span: HandoffSpan) {
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
		markers: [],
		metadata: { klippt: { clipId: span.id, assetId: span.assetId } },
	};
}

type Item = ReturnType<typeof gap> | ReturnType<typeof clip>;
type TrackSource = { file: string; durationSec: number | null; offsetSec: number };

export function buildSourceTimeline(title: string, sources: HandoffSource[], spans: HandoffSpan[]) {
	const sourceById = new Map(sources.map((source) => [source.assetId, source]));
	const frame = (sec: number) => Math.round(sec * SOURCE_TIMELINE_RATE + 1e-8);
	if (!spans.some((span) => frame(span.timelineEndSec) > frame(span.timelineStartSec)))
		throw new Error(
			"The kept edit is shorter than one timeline frame. Keep a longer span to export.",
		);
	const warnings = new Set<string>();
	const track = (
		name: string,
		kind: "Video" | "Audio",
		select: (source: HandoffSource) => TrackSource | undefined,
	) => {
		const children: Item[] = [];
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
			if (length) children.push(clip(media.file, sourceStart, length, available, span));
			if (duration > lead + length) children.push(gap(duration - lead - length));
			if (lead || duration > lead + length)
				warnings.add(`${media.file}: unavailable source time is left as a gap in timeline.otio.`);
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
					offsetSec: 0,
				}
			: undefined;
	};
	const tracks = [
		track("Screen", "Video", (source) => ({ ...source.screen, offsetSec: 0 })),
		track("Camera", "Video", (source) =>
			source.camera
				? { ...source.camera, offsetSec: (source.camera.startMs + source.camera.offsetMs) / 1000 }
				: undefined,
		),
		track("Microphone", "Audio", audio("microphone")),
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

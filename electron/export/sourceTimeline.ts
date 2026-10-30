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
	keepIndex?: number;
	reason?: string;
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
	provenance: ReturnType<typeof clipProvenance>,
) {
	return {
		OTIO_SCHEMA: "Clip.2",
		name: provenance.name,
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
				timelineStartSec: span.timelineStartSec,
				timelineEndSec: span.timelineEndSec,
				sourceOffsetSec: offsetSec,
				...provenance.metadata,
			},
		},
	};
}

type Item = ReturnType<typeof gap> | (ReturnType<typeof clip> & { enabled?: boolean });
type TrackSource = { file: string; durationSec: number | null; offsetSec: number };

export type SourceTrackRole = "screen" | "camera" | "microphone" | "system" | "audio";

export type PlannedItem =
	| { type: "gap"; duration: number }
	| {
			type: "clip";
			file: string;
			start: number;
			duration: number;
			available: number;
			span: HandoffSpan;
			offsetSec: number;
			take?: number;
			screenStartSec?: number;
	  };

export interface PlannedTrack {
	name: string;
	kind: "Video" | "Audio";
	role: SourceTrackRole;
	items: PlannedItem[];
}

/** Frame-grid placement of every kept span on every source track, shared by each timeline format. */
export function planSourceTimeline(sources: HandoffSource[], spans: HandoffSpan[]) {
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
		role: SourceTrackRole,
		select: (source: HandoffSource) => TrackSource | undefined,
	): PlannedTrack => {
		const items: PlannedItem[] = [];
		const pushGap = (duration: number) => items.push({ type: "gap", duration });
		for (const span of spans) {
			const duration = frame(span.timelineEndSec) - frame(span.timelineStartSec);
			if (duration <= 0) {
				warnings.add("A kept span shorter than one timeline frame was omitted from the timelines.");
				continue;
			}
			const source = sourceById.get(span.assetId);
			if (!source) throw new Error(`Missing timeline source: ${span.assetId}`);
			const media = select(source);
			if (!media) {
				pushGap(duration);
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
			if (lead) pushGap(lead);
			if (length)
				items.push({
					type: "clip",
					file: media.file,
					start: sourceStart,
					duration: length,
					available,
					span,
					offsetSec: media.offsetSec,
					take: sources.indexOf(source) + 1,
					screenStartSec: (frame(span.sourceStartSec) + lead) / SOURCE_TIMELINE_RATE,
				});
			if (duration > lead + length) pushGap(duration - lead - length);
			const missingSec = (duration - length) / SOURCE_TIMELINE_RATE;
			if (missingSec > SOURCE_GAP_WARNING_SEC)
				warnings.add(
					`${media.file}: ${missingSec.toFixed(1)} s of source time is missing and left as a gap in the timelines.`,
				);
		}
		return { name, kind, role, items };
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
	const tracks = [
		track("Screen", "Video", "screen", (source) => ({ ...source.screen, offsetSec: 0 })),
		track("Camera", "Video", "camera", (source) =>
			source.camera
				? { ...source.camera, offsetSec: (source.camera.startMs + source.camera.offsetMs) / 1000 }
				: undefined,
		),
		track("Microphone", "Audio", "microphone", audio("microphone")),
		track("System audio", "Audio", "system", audio("system")),
	];
	if (sources.some((source) => source.screen.audio.some((item) => item.role === "audio")))
		tracks.push(track("Original audio (unidentified)", "Audio", "audio", audio("audio")));
	return { tracks, warnings: [...warnings] };
}

/** Markers sit on one host track's clips in source media time, as Resolve expects. */
export function buildSourceTimeline(
	title: string,
	sources: HandoffSource[],
	spans: HandoffSpan[],
	markers: TimelineMarker[] = [],
	cleanDialogue?: { file: string; samples: number },
) {
	const plan = planSourceTimeline(sources, spans);
	const markerFrames = markers.map((entry) => ({
		entry,
		frame: Math.round(entry.timelineSec * SOURCE_TIMELINE_RATE + 1e-8),
	}));
	const hostRole =
		!cleanDialogue &&
		sources.some((source) => source.screen.audio.some((item) => item.role === "microphone"))
			? "microphone"
			: "screen";
	const tracks = plan.tracks.map((track) => {
		let position = 0;
		const children = track.items.map((item): Item => {
			const from = position;
			position += item.duration;
			if (item.type === "gap") return gap(item.duration);
			const piece = clip(
				item.file,
				item.start,
				item.duration,
				item.available,
				item.span,
				item.offsetSec,
				clipProvenance(item, track.role, from),
			);
			if (track.role === hostRole)
				for (const { entry, frame: at } of markerFrames)
					if (at >= from && at < position)
						piece.markers.push(marker(entry, item.start + at - from));
			return cleanDialogue && track.role === "microphone" ? { ...piece, enabled: false } : piece;
		});
		return {
			OTIO_SCHEMA: "Track.1",
			name: track.name,
			kind: track.kind,
			children,
			source_range: null,
			effects: [],
			markers: [],
			metadata: {},
		};
	});
	if (cleanDialogue) {
		const duration = cleanDialogue.samples / 800;
		const span: HandoffSpan = {
			id: "clean-dialogue",
			assetId: "clean-dialogue",
			sourceStartSec: 0,
			timelineStartSec: 0,
			timelineEndSec: duration / SOURCE_TIMELINE_RATE,
		};
		tracks.push({
			OTIO_SCHEMA: "Track.1",
			name: "Clean dialogue",
			kind: "Audio",
			children: [
				clip(
					cleanDialogue.file,
					0,
					duration,
					duration,
					span,
					0,
					clipProvenance(
						{
							type: "clip",
							file: cleanDialogue.file,
							start: 0,
							duration,
							available: duration,
							span,
							offsetSec: 0,
						},
						"clean-dialogue",
						0,
					),
				),
			],
			source_range: null,
			effects: [],
			markers: [],
			metadata: {},
		});
	}
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
		plan,
		warnings: plan.warnings,
	};
}

export function clipProvenance(
	item: Extract<PlannedItem, { type: "clip" }>,
	role: string,
	timelineStartFrame: number,
) {
	const sourceStartSec = item.start / SOURCE_TIMELINE_RATE;
	const sourceEndSec = (item.start + item.duration) / SOURCE_TIMELINE_RATE;
	const take = item.take ?? 0;
	return {
		name: `T${String(take).padStart(3, "0")} ${role} ${sourceStartSec.toFixed(2)}–${sourceEndSec.toFixed(2)}s`,
		metadata: {
			assetId: item.span.assetId,
			take,
			role,
			sourceStartSec: item.span.sourceStartSec,
			sourceEndSec:
				item.span.sourceEndSec ??
				item.span.sourceStartSec + item.span.timelineEndSec - item.span.timelineStartSec,
			streamSourceStartSec: sourceStartSec,
			streamSourceEndSec: sourceEndSec,
			sourceStartFrame: item.start,
			sourceEndFrame: item.start + item.duration,
			timelineStartFrame,
			timelineEndFrame: timelineStartFrame + item.duration,
			...(item.span.keepIndex === undefined ? {} : { keepIndex: item.span.keepIndex }),
			...(item.span.reason ? { reason: item.span.reason } : {}),
		},
	};
}

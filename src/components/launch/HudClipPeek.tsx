import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { formatTimePadded } from "@/utils/timeUtils";
import styles from "./LaunchWindow.module.css";

/** How much of the recording plays back when the replay opens. */
export const CLIP_PEEK_LEAD_IN_SECONDS = 5;

export interface HudClipPeekLabels {
	title: string;
	clipOf: (current: number, total: number) => string;
	play: string;
	pause: string;
	mute: string;
	unmute: string;
	seek: string;
}

interface PeekClip {
	clip: RecordingSessionClip;
	start: number;
	duration: number;
}

/** Lays kept clips end to end on one timeline, in recording order. */
export function buildPeekTimeline(clips: readonly RecordingSessionClip[]): PeekClip[] {
	let start = 0;
	return clips
		.filter((clip) => !clip.removed)
		.sort((left, right) => left.index - right.index)
		.map((clip) => {
			const duration = Math.max(0, clip.durationMs / 1_000);
			const entry = { clip, start, duration };
			start += duration;
			return entry;
		});
}

/** Which clip a timeline position falls in, and where inside it. */
export function locatePeekTime(timeline: readonly PeekClip[], time: number) {
	const last = timeline.length - 1;
	for (let index = 0; index <= last; index += 1) {
		const entry = timeline[index];
		if (time < entry.start + entry.duration || index === last) {
			return { index, offset: Math.min(entry.duration, Math.max(0, time - entry.start)) };
		}
	}
	return { index: 0, offset: 0 };
}

/**
 * Replays what has been recorded so far, while paused, so the creator can pick
 * up where they left off. It plays the kept clip files exactly as written; it
 * has no recording controls and never changes the session.
 *
 * It stays mounted for the whole pause and only shows or hides, so toggling it
 * quickly never reloads the video and its frame already has the recording's shape.
 */
export function HudClipPeek({
	clips,
	labels,
	open,
	panelRef,
	onClose,
}: {
	clips: readonly RecordingSessionClip[];
	labels: HudClipPeekLabels;
	open: boolean;
	panelRef?: (el: HTMLDivElement | null) => void;
	onClose: () => void;
}) {
	const timeline = useMemo(() => buildPeekTimeline(clips), [clips]);
	const total = timeline.reduce((sum, entry) => sum + entry.duration, 0);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [initial] = useState(() =>
		locatePeekTime(timeline, Math.max(0, total - CLIP_PEEK_LEAD_IN_SECONDS)),
	);
	const pendingOffsetRef = useRef<number | null>(initial.offset);
	const [clipIndex, setClipIndex] = useState(initial.index);
	const [position, setPosition] = useState((timeline[initial.index]?.start ?? 0) + initial.offset);
	const [playing, setPlaying] = useState(false);
	const [muted, setMuted] = useState(false);
	// The first clip that loads sets the frame; a clip of another size letterboxes inside it.
	const [aspect, setAspect] = useState<number | null>(null);

	// A src change aborts a pending play(); that is not the user pausing.
	const stopUnlessInterrupted = useCallback((error: unknown) => {
		if (!(error instanceof DOMException && error.name === "AbortError")) setPlaying(false);
	}, []);

	const current = timeline[Math.min(clipIndex, timeline.length - 1)];
	const source = current ? toKlipptMediaUrl(current.clip.screenVideoPath) : undefined;

	const seek = useCallback(
		(time: number) => {
			const target = locatePeekTime(timeline, Math.min(total, Math.max(0, time)));
			setPosition(timeline[target.index].start + target.offset);
			if (target.index === clipIndex && videoRef.current) {
				pendingOffsetRef.current = null;
				videoRef.current.currentTime = target.offset;
				return;
			}
			pendingOffsetRef.current = target.offset;
			setClipIndex(target.index);
		},
		[clipIndex, timeline, total],
	);

	useEffect(() => {
		if (clipIndex >= timeline.length && timeline.length > 0) setClipIndex(timeline.length - 1);
	}, [clipIndex, timeline.length]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		if (playing) video.play()?.catch(stopUnlessInterrupted);
		else video.pause();
	}, [playing, stopUnlessInterrupted]);

	useEffect(() => {
		if (!playing || !current) return;
		let frame = 0;
		const tick = () => {
			const video = videoRef.current;
			if (video && pendingOffsetRef.current === null) {
				setPosition(current.start + Math.min(current.duration, video.currentTime));
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [current, playing]);

	useEffect(() => {
		if (!open) return;
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" || event.key === "ArrowDown") {
				event.preventDefault();
				onClose();
			} else if (event.key === "ArrowLeft") {
				event.preventDefault();
				const sinceStart = position - (current?.start ?? 0);
				const target = sinceStart > 1 ? clipIndex : Math.max(0, clipIndex - 1);
				seek(timeline[target]?.start ?? 0);
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				if (clipIndex < timeline.length - 1) seek(timeline[clipIndex + 1].start);
			} else if (event.key === "m" || event.key === "M") {
				setMuted((value) => !value);
			}
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [clipIndex, current, onClose, open, position, seek, timeline]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const attachPanel = useCallback(
		(el: HTMLDivElement | null) => {
			rootRef.current = el;
			panelRef?.(el);
		},
		[panelRef],
	);
	useEffect(() => {
		if (aspect) rootRef.current?.style.setProperty("--peek-aspect", String(aspect));
	}, [aspect]);

	const playButtonRef = useRef<HTMLButtonElement | null>(null);
	const seekRef = useRef(seek);
	seekRef.current = seek;
	useEffect(() => {
		if (!open) {
			setPlaying(false);
			return;
		}
		seekRef.current(total - CLIP_PEEK_LEAD_IN_SECONDS);
		setPlaying(true);
		playButtonRef.current?.focus({ preventScroll: true });
	}, [open, total]);

	const handleLoadedMetadata = () => {
		const video = videoRef.current;
		const offset = pendingOffsetRef.current;
		pendingOffsetRef.current = null;
		if (video && aspect === null && video.videoWidth > 0 && video.videoHeight > 0) {
			setAspect(video.videoWidth / video.videoHeight);
		}
		if (video && offset !== null) video.currentTime = offset;
		if (video && playing) video.play()?.catch(stopUnlessInterrupted);
	};

	const handleEnded = () => {
		if (clipIndex < timeline.length - 1) {
			pendingOffsetRef.current = 0;
			setClipIndex(clipIndex + 1);
			return;
		}
		setPosition(total);
		setPlaying(false);
	};

	const togglePlaying = () => {
		if (!playing && position >= total - 0.05) seek(0);
		setPlaying((value) => !value);
	};

	const seekFromPointer = (clientX: number) => {
		const rect = trackRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return;
		seek(((clientX - rect.left) / rect.width) * total);
	};

	if (!current) return null;

	return (
		<div
			ref={attachPanel}
			hidden={!open}
			data-hud-interactive="true"
			data-testid="hud-clip-peek"
			role="dialog"
			aria-label={labels.title}
			className={`${styles.clipPeek} animate-mic-panel-in ${styles.electronNoDrag}`}
		>
			<div className={styles.clipPeekStage}>
				<video
					ref={videoRef}
					data-testid="hud-clip-peek-video"
					className={styles.clipPeekVideo}
					src={source}
					muted={muted}
					playsInline
					preload="auto"
					onLoadedMetadata={handleLoadedMetadata}
					onEnded={handleEnded}
					onClick={togglePlaying}
				/>
				<span className={styles.clipPeekLabel}>
					{labels.clipOf(clipIndex + 1, timeline.length)}
				</span>
				<button
					type="button"
					className={styles.clipPeekMute}
					aria-label={muted ? labels.unmute : labels.mute}
					aria-pressed={muted}
					onClick={() => setMuted((value) => !value)}
				>
					{muted ? <VolumeX size={15} aria-hidden /> : <Volume2 size={15} aria-hidden />}
				</button>
			</div>
			<div className={styles.clipPeekControls}>
				<button
					type="button"
					ref={playButtonRef}
					data-testid="hud-clip-peek-play"
					className={styles.clipPeekPlay}
					aria-label={playing ? labels.pause : labels.play}
					onClick={togglePlaying}
				>
					{playing ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
				</button>
				<div
					ref={trackRef}
					role="slider"
					tabIndex={0}
					aria-label={labels.seek}
					aria-valuemin={0}
					aria-valuemax={Math.round(total)}
					aria-valuenow={Math.round(position)}
					className={styles.clipPeekTrack}
					onKeyDown={(event) => {
						const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[
							event.key as "ArrowLeft"
						];
						if (step === undefined && event.key !== "Home" && event.key !== "End") return;
						event.preventDefault();
						event.stopPropagation();
						seek(event.key === "Home" ? 0 : event.key === "End" ? total : position + (step ?? 0));
					}}
					onPointerDown={(event) => {
						event.currentTarget.setPointerCapture(event.pointerId);
						seekFromPointer(event.clientX);
					}}
					onPointerMove={(event) => {
						if (event.currentTarget.hasPointerCapture(event.pointerId)) {
							seekFromPointer(event.clientX);
						}
					}}
				>
					{timeline.map((entry) => {
						const filled =
							entry.duration > 0
								? Math.min(1, Math.max(0, (position - entry.start) / entry.duration))
								: 0;
						return (
							<span
								key={entry.clip.index}
								className={styles.clipPeekSegment}
								style={{ flexGrow: Math.max(entry.duration, 0.001) }}
							>
								<span
									className={styles.clipPeekSegmentFill}
									style={{ transform: `scaleX(${filled})` }}
								/>
							</span>
						);
					})}
				</div>
				<span className={styles.clipPeekTime}>
					{formatTimePadded(Math.floor(position))} / {formatTimePadded(Math.round(total))}
				</span>
			</div>
		</div>
	);
}

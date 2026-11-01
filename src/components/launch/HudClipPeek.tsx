import { Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyPreviewAudio, usePreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import { loadEditingPreferences } from "@/lib/ai-edition/store/editingPreferences";
import { webcamSizeToFraction } from "@/lib/compositeLayout";
import { followCamera } from "@/lib/followCamera";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { useReleasingMediaRef } from "@/lib/releasingMediaRef";
import { formatTimePadded } from "@/utils/timeUtils";
import styles from "./LaunchWindow.module.css";

/** How much of the recording plays back when the replay opens. */
const CLIP_PEEK_LEAD_IN_SECONDS = 5;

export interface HudClipPeekLabels {
	title: string;
	clipOf: (current: number, total: number) => string;
	play: string;
	pause: string;
	mute: string;
	unmute: string;
	volume: string;
	seek: string;
	playbackError?: string;
	retry?: string;
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

/** Where the review will draw the camera, so the replay shows it in the same place. */
export interface PeekCameraPlacement {
	webcamPosition: { cx: number; cy: number } | null;
	webcamSizePreset: number;
	webcamMirrored: boolean;
}

/** The camera's box inside the replay stage: the remembered size and spot, in its own shape. */
export function peekCameraStyle(placement: PeekCameraPlacement, portrait: boolean): CSSProperties {
	const longSide = `${(webcamSizeToFraction(placement.webcamSizePreset) * 100).toFixed(2)}cqmin`;
	const position = placement.webcamPosition;
	return {
		...(portrait ? { height: longSide } : { width: longSide }),
		...(position
			? { left: `${position.cx * 100}%`, top: `${position.cy * 100}%`, translate: "-50% -50%" }
			: { right: "2cqmin", bottom: "2cqmin" }),
		...(placement.webcamMirrored ? { scale: "-1 1" } : {}),
	};
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
	instant = false,
	panelRef,
	onClose,
}: {
	clips: readonly RecordingSessionClip[];
	labels: HudClipPeekLabels;
	open: boolean;
	/** Opened from the keyboard: show it without animation. */
	instant?: boolean;
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
	const [playbackFailed, setPlaybackFailed] = useState(false);
	const [mediaGeneration, setMediaGeneration] = useState(0);
	const playbackGenerationRef = useRef(0);
	// The same listening level as the review, so the replay never surprises with its loudness.
	const volume = usePreviewAudio((state) => state.volume);
	const muted = usePreviewAudio((state) => state.muted);
	const setVolume = usePreviewAudio((state) => state.setVolume);
	const toggleMuted = usePreviewAudio((state) => state.toggleMuted);
	const silent = muted || volume === 0;
	// The first clip that loads sets the frame; a clip of another size letterboxes inside it.
	const [aspect, setAspect] = useState<number | null>(null);

	const failPlayback = useCallback(() => {
		playbackGenerationRef.current += 1;
		videoRef.current?.pause();
		cameraRef.current?.pause();
		setPlaying(false);
		setPlaybackFailed(true);
	}, []);

	const current = timeline[Math.min(clipIndex, timeline.length - 1)];
	const retryQuery = mediaGeneration > 0 ? `?replayRetry=${mediaGeneration}` : "";
	const source = current
		? `${toKlipptMediaUrl(current.clip.screenVideoPath)}${retryQuery}`
		: undefined;
	const cameraPath = current?.clip.webcamVideoPath;
	const cameraSource = cameraPath ? `${toKlipptMediaUrl(cameraPath)}${retryQuery}` : undefined;
	const cameraOffsetSec = (current?.clip.webcamOffsetMs ?? 0) / 1_000;
	const cameraRef = useRef<HTMLVideoElement | null>(null);
	const attachVideo = useReleasingMediaRef(videoRef);
	const attachCamera = useReleasingMediaRef(cameraRef);
	// No media until the replay is first opened: a hidden decoder at every pause costs the
	// pill's memory. Once opened it stays loaded, so toggling never reloads it.
	const [loaded, setLoaded] = useState(open);
	if (open && !loaded) setLoaded(true);
	const requestPlay = useCallback(
		async (video: HTMLVideoElement) => {
			const generation = playbackGenerationRef.current;
			try {
				await video.play();
			} catch (error) {
				if (generation !== playbackGenerationRef.current) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				failPlayback();
			}
		},
		[failPlayback],
	);
	const [cameraPortrait, setCameraPortrait] = useState(false);
	// Read when the replay opens: the creator may have moved the camera in review since.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read on each open
	const cameraPlacement = useMemo(() => loadEditingPreferences().editor, [open]);
	const showCamera = Boolean(cameraSource) && cameraPlacement.webcamLayoutPreset !== "no-webcam";

	// The camera file follows the screen file: same moment, same play state.
	useEffect(() => {
		if (!open || !showCamera) return;
		let frame = 0;
		const tick = () => {
			frame = requestAnimationFrame(tick);
			const video = videoRef.current;
			const camera = cameraRef.current;
			if (!video || !camera) return;
			followCamera(video, camera, cameraOffsetSec, (cam) => void requestPlay(cam));
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [open, showCamera, cameraOffsetSec, requestPlay]);

	const seek = useCallback(
		(time: number) => {
			const target = locatePeekTime(timeline, Math.min(total, Math.max(0, time)));
			setPosition(timeline[target.index].start + target.offset);
			if (target.index === clipIndex && videoRef.current && videoRef.current.readyState >= 1) {
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
		if (!video || !source) return;
		if (open && playing) void requestPlay(video);
		else video.pause();
		return () => {
			playbackGenerationRef.current += 1;
		};
	}, [open, playing, source, requestPlay]);

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
				toggleMuted();
			}
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [clipIndex, current, onClose, open, position, seek, timeline, toggleMuted]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a retry mounts a fresh media element
	useEffect(() => {
		applyPreviewAudio(videoRef.current, { volume, muted });
	}, [volume, muted, mediaGeneration]);

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
		setPlaybackFailed(false);
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
		if (video && playing) void requestPlay(video);
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
		if (playbackFailed) return;
		if (!playing && position >= total - 0.05) seek(0);
		setPlaying((value) => !value);
	};
	const retryPlayback = () => {
		playbackGenerationRef.current += 1;
		pendingOffsetRef.current = Math.max(0, position - (current?.start ?? 0));
		setPlaybackFailed(false);
		setMediaGeneration((generation) => generation + 1);
		setPlaying(true);
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
			data-instant={instant}
			className={`${styles.clipPeek} ${styles.hudPanel} ${styles.electronNoDrag}`}
		>
			<div className={styles.clipPeekStage}>
				{loaded && (
					<video
						key={`screen-${mediaGeneration}`}
						ref={attachVideo}
						data-testid="hud-clip-peek-video"
						className={styles.clipPeekVideo}
						src={source}
						playsInline
						preload="auto"
						onLoadedMetadata={handleLoadedMetadata}
						onEnded={handleEnded}
						onError={failPlayback}
						onClick={togglePlaying}
					/>
				)}
				{loaded && showCamera && (
					<video
						key={`camera-${mediaGeneration}`}
						ref={attachCamera}
						data-testid="hud-clip-peek-camera"
						className={styles.clipPeekCamera}
						style={peekCameraStyle(cameraPlacement, cameraPortrait)}
						src={cameraSource}
						muted
						playsInline
						preload="auto"
						onError={failPlayback}
						onLoadedMetadata={(event) => {
							const camera = event.currentTarget;
							setCameraPortrait(camera.videoHeight > camera.videoWidth);
						}}
					/>
				)}
				<span className={styles.clipPeekLabel}>
					{labels.clipOf(clipIndex + 1, timeline.length)}
				</span>
				<div className={styles.clipPeekVolume} data-silent={silent}>
					<button
						type="button"
						className={styles.clipPeekMute}
						aria-label={muted ? labels.unmute : labels.mute}
						aria-pressed={muted}
						onClick={toggleMuted}
					>
						{silent ? (
							<VolumeX size={15} aria-hidden />
						) : volume < 0.5 ? (
							<Volume1 size={15} aria-hidden />
						) : (
							<Volume2 size={15} aria-hidden />
						)}
					</button>
					<div className={styles.clipPeekVolumePop}>
						<input
							type="range"
							min={0}
							max={1}
							step={0.01}
							value={muted ? 0 : volume}
							aria-label={labels.volume}
							className={styles.clipPeekVolumeInput}
							onChange={(event) => setVolume(Number(event.target.value))}
							onKeyDown={(event) => {
								if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
									event.stopPropagation();
								}
							}}
						/>
					</div>
				</div>
			</div>
			{playbackFailed && (
				<div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
					<span role="alert" className="text-[var(--hud-ink)]">
						{labels.playbackError ?? "Unable to play this clip"}
					</span>
					<button type="button" className={styles.hudSetupFooterButton} onClick={retryPlayback}>
						{labels.retry ?? "Try again"}
					</button>
				</div>
			)}
			<div className={styles.clipPeekControls}>
				<button
					type="button"
					ref={playButtonRef}
					data-testid="hud-clip-peek-play"
					className={styles.clipPeekPlay}
					aria-label={playing ? labels.pause : labels.play}
					onClick={togglePlaying}
					disabled={playbackFailed}
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

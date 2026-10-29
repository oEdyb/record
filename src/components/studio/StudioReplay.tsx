import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyPreviewAudio, usePreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import { loadEditingPreferences } from "@/lib/ai-edition/store/editingPreferences";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { formatTimePadded } from "@/utils/timeUtils";
import { buildPeekTimeline, locatePeekTime, peekCameraStyle } from "../launch/HudClipPeek";
import peek from "../launch/LaunchWindow.module.css";
import styles from "./StudioWindow.module.css";

/** Where a fresh replay waits: just before the end, like the pill's replay. */
const LEAD_IN_SECONDS = 5;

export interface StudioReplayLabels {
	clipOf: (current: number, total: number) => string;
	play: string;
	pause: string;
	mute: string;
	unmute: string;
	seek: string;
	playbackError: string;
}

/**
 * The clips recorded so far, end to end, with the camera where the review puts it. It
 * waits paused near the end until asked; it never plays on its own, and stops when
 * capture resumes so its sound cannot reach the microphone.
 */
export function StudioReplay({
	clips,
	labels,
	seekRequest,
	hold,
	onPosition,
}: {
	clips: readonly RecordingSessionClip[];
	labels: StudioReplayLabels;
	/** A transcript click: jump here on the take's timeline. */
	seekRequest: { takeSec: number; nonce: number } | null;
	/** Capture is running: stop playback. */
	hold: boolean;
	onPosition: (takeSec: number) => void;
}) {
	const timeline = useMemo(() => buildPeekTimeline(clips), [clips]);
	const total = timeline.reduce((sum, entry) => sum + entry.duration, 0);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const cameraRef = useRef<HTMLVideoElement | null>(null);
	const trackRef = useRef<HTMLDivElement | null>(null);
	const pendingOffsetRef = useRef<number | null>(null);
	const touchedRef = useRef(false);
	const [clipIndex, setClipIndex] = useState(0);
	const [position, setPosition] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [failed, setFailed] = useState(false);
	const [aspect, setAspect] = useState(16 / 9);
	const [cameraPortrait, setCameraPortrait] = useState(false);
	const volume = usePreviewAudio((state) => state.volume);
	const muted = usePreviewAudio((state) => state.muted);
	const toggleMuted = usePreviewAudio((state) => state.toggleMuted);
	const placement = useMemo(() => loadEditingPreferences().editor, []);

	const current = timeline[Math.min(clipIndex, timeline.length - 1)];
	const source = current ? toKlipptMediaUrl(current.clip.screenVideoPath) : undefined;
	const cameraPath = current?.clip.webcamVideoPath;
	const showCamera = Boolean(cameraPath) && placement.webcamLayoutPreset !== "no-webcam";
	const cameraOffsetSec = (current?.clip.webcamOffsetMs ?? 0) / 1000;

	const seek = useCallback(
		(time: number) => {
			if (timeline.length === 0) return;
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
	const seekRef = useRef(seek);
	seekRef.current = seek;

	// A new clip arrived: wait near its end, unless the creator is looking at something else.
	useEffect(() => {
		if (!touchedRef.current) seekRef.current(total - LEAD_IN_SECONDS);
	}, [total]);

	useEffect(() => {
		if (!seekRequest) return;
		touchedRef.current = true;
		seekRef.current(seekRequest.takeSec);
	}, [seekRequest]);

	useEffect(() => {
		if (hold) setPlaying(false);
	}, [hold]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !source) return;
		if (playing) video.play().catch(() => setPlaying(false));
		else video.pause();
	}, [playing, source]);

	// A new clip loads a new source: give it the same listening level.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-applied per source
	useEffect(() => {
		applyPreviewAudio(videoRef.current, { volume, muted });
	}, [volume, muted, source]);

	// The position follows the video; the camera file follows the screen file.
	useEffect(() => {
		let frame = 0;
		const tick = () => {
			frame = requestAnimationFrame(tick);
			const video = videoRef.current;
			if (!video || !current) return;
			if (playing && pendingOffsetRef.current === null)
				setPosition(current.start + Math.min(current.duration, video.currentTime));
			const camera = cameraRef.current;
			if (!camera || camera.readyState < 1) return;
			const target = Math.max(0, video.currentTime - cameraOffsetSec);
			if (Math.abs(camera.currentTime - target) > 0.15) camera.currentTime = target;
			if (video.paused || video.ended) {
				if (!camera.paused) camera.pause();
			} else if (camera.paused && !camera.ended) void camera.play().catch(() => undefined);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [current, playing, cameraOffsetSec]);

	// Quarter seconds are enough to follow along in the transcript.
	useEffect(() => onPosition(Math.floor(position * 4) / 4), [onPosition, position]);

	const handleLoadedMetadata = () => {
		const video = videoRef.current;
		if (!video) return;
		if (video.videoWidth > 0 && video.videoHeight > 0)
			setAspect(video.videoWidth / video.videoHeight);
		const offset = pendingOffsetRef.current;
		pendingOffsetRef.current = null;
		if (offset !== null) video.currentTime = offset;
		if (playing) video.play().catch(() => setPlaying(false));
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
		if (failed || hold) return;
		touchedRef.current = true;
		if (!playing && position >= total - 0.05) seek(0);
		setPlaying((value) => !value);
	};

	const seekFromPointer = (clientX: number) => {
		const rect = trackRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return;
		touchedRef.current = true;
		seek(((clientX - rect.left) / rect.width) * total);
	};

	if (!current) return null;
	const silent = muted || volume === 0;
	return (
		<div className={styles.replay} style={{ "--peek-aspect": String(aspect) } as CSSProperties}>
			<div className={styles.stageSlot}>
				<div className={`${peek.clipPeekStage} ${styles.stage}`}>
					<video
						ref={videoRef}
						className={peek.clipPeekVideo}
						src={source}
						playsInline
						preload="auto"
						onLoadedMetadata={handleLoadedMetadata}
						onEnded={handleEnded}
						onError={() => {
							setPlaying(false);
							setFailed(true);
						}}
						onClick={togglePlaying}
					/>
					{showCamera && cameraPath ? (
						<video
							ref={cameraRef}
							className={peek.clipPeekCamera}
							style={peekCameraStyle(placement, cameraPortrait)}
							src={toKlipptMediaUrl(cameraPath)}
							muted
							playsInline
							preload="auto"
							onLoadedMetadata={(event) =>
								setCameraPortrait(event.currentTarget.videoHeight > event.currentTarget.videoWidth)
							}
						/>
					) : null}
					<span className={peek.clipPeekLabel}>
						{labels.clipOf(clipIndex + 1, timeline.length)}
					</span>
					<div className={peek.clipPeekVolume} data-silent={silent}>
						<button
							type="button"
							className={peek.clipPeekMute}
							aria-label={muted ? labels.unmute : labels.mute}
							aria-pressed={muted}
							onClick={toggleMuted}
						>
							{silent ? <VolumeX size={15} aria-hidden /> : <Volume2 size={15} aria-hidden />}
						</button>
					</div>
				</div>
			</div>
			{failed ? (
				<p role="alert" className={styles.replayError}>
					{labels.playbackError}
				</p>
			) : null}
			<div className={`${peek.clipPeekControls} ${styles.replayControls}`}>
				<button
					type="button"
					className={peek.clipPeekPlay}
					aria-label={playing ? labels.pause : labels.play}
					onClick={togglePlaying}
					disabled={failed || hold}
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
					className={peek.clipPeekTrack}
					onKeyDown={(event) => {
						const step = { ArrowLeft: -5, ArrowRight: 5 }[event.key as "ArrowLeft"];
						if (step === undefined) return;
						event.preventDefault();
						touchedRef.current = true;
						seek(position + step);
					}}
					onPointerDown={(event) => {
						event.currentTarget.setPointerCapture(event.pointerId);
						seekFromPointer(event.clientX);
					}}
					onPointerMove={(event) => {
						if (event.currentTarget.hasPointerCapture(event.pointerId))
							seekFromPointer(event.clientX);
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
								className={peek.clipPeekSegment}
								style={{ flexGrow: Math.max(entry.duration, 0.001) }}
							>
								<span
									className={peek.clipPeekSegmentFill}
									style={{ transform: `scaleX(${filled})` }}
								/>
							</span>
						);
					})}
				</div>
				<span className={peek.clipPeekTime}>
					{formatTimePadded(Math.floor(position))} / {formatTimePadded(Math.round(total))}
				</span>
			</div>
		</div>
	);
}

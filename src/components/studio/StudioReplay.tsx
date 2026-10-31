import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyPreviewAudio, usePreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import { loadEditingPreferences } from "@/lib/ai-edition/store/editingPreferences";
import { followCamera } from "@/lib/followCamera";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import { useReleasingMediaRef } from "@/lib/releasingMediaRef";
import { buildPeekTimeline, locatePeekTime, peekCameraStyle } from "../launch/HudClipPeek";
import peek from "../launch/LaunchWindow.module.css";
import { StudioSeekBar } from "./StudioSeekBar";
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
	recorded: string;
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
	shown,
	onPosition,
	playbackRequest = 0,
	speed = 1,
	cameraOnly = false,
}: {
	clips: readonly RecordingSessionClip[];
	labels: StudioReplayLabels;
	/** A transcript click: jump here on the take's timeline. */
	seekRequest: { takeSec: number; nonce: number; play?: boolean } | null;
	/** Capture is running: stop playback. */
	hold: boolean;
	/** The window is on screen. Hidden, it holds no media; the playhead stays in state. */
	shown: boolean;
	onPosition: (takeSec: number) => void;
	playbackRequest?: number;
	speed?: number;
	cameraOnly?: boolean;
}) {
	const timeline = useMemo(() => buildPeekTimeline(clips), [clips]);
	const total = timeline.reduce((sum, entry) => sum + entry.duration, 0);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const cameraRef = useRef<HTMLVideoElement | null>(null);
	const attachVideo = useReleasingMediaRef(videoRef);
	const attachCamera = useReleasingMediaRef(cameraRef);
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
		if (seekRequest.play && !hold) setPlaying(true);
	}, [seekRequest, hold]);

	useEffect(() => {
		if (!hold) return;
		setPlaying(false);
		// Pause right away rather than on the next render: capture is about to start.
		videoRef.current?.pause();
		cameraRef.current?.pause();
	}, [hold]);

	// A hidden Studio keeps its page alive; it must not keep playing, or decoding, out of sight.
	const resumeAtRef = useRef(0);
	resumeAtRef.current = position - (current?.start ?? 0);
	useEffect(() => {
		if (shown) {
			pendingOffsetRef.current = Math.max(0, resumeAtRef.current);
			return;
		}
		setPlaying(false);
		videoRef.current?.pause();
		cameraRef.current?.pause();
	}, [shown]);

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
			if (camera)
				followCamera(
					video,
					camera,
					cameraOffsetSec,
					(cam) => void cam.play().catch(() => undefined),
				);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [current, playing, cameraOffsetSec]);

	// Quarter seconds are enough to follow along in the transcript.
	useEffect(() => onPosition(Math.floor(position * 4) / 4), [onPosition, position]);

	const handleLoadedMetadata = () => {
		const video = videoRef.current;
		if (!video) return;
		video.playbackRate = speed;
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

	const lastPlaybackRequest = useRef(playbackRequest);
	useEffect(() => {
		if (lastPlaybackRequest.current === playbackRequest) return;
		lastPlaybackRequest.current = playbackRequest;
		if (hold || failed || !timeline.length) return;
		if (position >= total - 0.05) seekRef.current(0);
		setPlaying((p) => !p);
	}, [playbackRequest, hold, failed, timeline.length, position, total]);
	useEffect(() => {
		if (videoRef.current) videoRef.current.playbackRate = speed;
		if (cameraRef.current) cameraRef.current.playbackRate = speed;
	}, [speed]);

	const togglePlaying = () => {
		if (failed || hold) return;
		touchedRef.current = true;
		if (!playing && position >= total - 0.05) seek(0);
		setPlaying((value) => !value);
	};

	if (!current) return null;
	const silent = muted || volume === 0;
	return (
		<div className={styles.replay} style={{ "--peek-aspect": String(aspect) } as CSSProperties}>
			<div className={styles.stageSlot} hidden={cameraOnly}>
				<div className={`${peek.clipPeekStage} ${styles.stage}`}>
					{shown ? (
						<video
							ref={attachVideo}
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
					) : null}
					{shown && showCamera && cameraPath ? (
						<video
							ref={attachCamera}
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
						{showCamera ? ` · ${labels.recorded}` : ""}
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
				<button
					type="button"
					className={peek.clipPeekPlay}
					aria-label={`${labels.seek} −5`}
					disabled={hold}
					onClick={() => seek(position - 5)}
				>
					‹
				</button>
				<button
					type="button"
					className={peek.clipPeekPlay}
					aria-label={`${labels.seek} +5`}
					disabled={hold}
					onClick={() => seek(position + 5)}
				>
					›
				</button>
				<span className={peek.clipPeekTime}>{speed}×</span>
				<StudioSeekBar
					timeline={timeline}
					total={total}
					position={position}
					label={labels.seek}
					onSeek={(time) => {
						touchedRef.current = true;
						seek(time);
					}}
				/>
			</div>
		</div>
	);
}

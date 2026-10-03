import { useEffect, useMemo, useRef, useState } from "react";
import { applyPreviewAudio, usePreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { audioOutputTime, buildAudioOutputClock } from "@/lib/ai-edition/timeline/audioOutputClock";
import type { PlaybackClockRef } from "@/lib/ai-edition/timeline/playback-clock";
import { requireNativeBridgeData } from "@/native/client";
import {
	buildAudioOverlays,
	buildSceneDescription,
	resolveVisibleClips,
} from "@/native/sceneDescription";

/** One cached native-mixed stem; the source clock remains the playback authority. */
export function AudioOverlayPlayback({ clockRef }: { clockRef: PlaybackClockRef }) {
	const document = useProjectStore((state) => state.document);
	const audioRef = useRef<HTMLAudioElement>(null);
	const [sourceUrl, setSourceUrl] = useState<string | null>(null);
	const previewVolume = usePreviewAudio((s) => s.volume);
	const previewMuted = usePreviewAudio((s) => s.muted);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the <audio> mounts with sourceUrl
	useEffect(() => {
		applyPreviewAudio(audioRef.current, { volume: previewVolume, muted: previewMuted });
	}, [previewVolume, previewMuted, sourceUrl]);
	const [mediaReady, setMediaReady] = useState(false);
	const [playbackFailed, setPlaybackFailed] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const compiled = useMemo(() => {
		if (!document?.timeline.audioClips?.length) return null;
		const scene = buildSceneDescription(document);
		const clock = buildAudioOutputClock(
			resolveVisibleClips(document),
			document.timeline.clips,
			scene.speedRegions,
		);
		const durationSec = clock.length ? clock[clock.length - 1].outputEnd : 0;
		return {
			clock,
			request: JSON.stringify({ audioOverlays: buildAudioOverlays(document), durationSec }),
		};
	}, [document]);
	const requestJson = compiled?.request ?? null;
	useEffect(() => {
		let obsolete = false;
		setSourceUrl(null);
		setMediaReady(false);
		setPlaybackFailed(false);
		setNotice(null);
		if (!requestJson) return;
		useProjectStore.getState().setPlaying(false);
		setNotice("Preparing music and sound effects…");
		void requireNativeBridgeData<{ sourceUrl: string }>({
			domain: "compositor",
			action: "audioOverlayStem",
			payload: JSON.parse(requestJson),
		})
			.then((result) => {
				if (obsolete) return;
				setSourceUrl(result.sourceUrl);
				setNotice("Loading music and sound effects…");
			})
			.catch((error: unknown) => {
				if (obsolete) return;
				useProjectStore.getState().setPlaying(false);
				setNotice(
					`Music preview failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		return () => {
			obsolete = true;
		};
	}, [requestJson]);
	useEffect(() => {
		if (!requestJson || (sourceUrl && mediaReady && !playbackFailed)) return;
		useProjectStore.getState().setPlaying(false);
		return useProjectStore.subscribe((state) => {
			if (state.playing) state.setPlaying(false);
		});
	}, [requestJson, sourceUrl, mediaReady, playbackFailed]);
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !sourceUrl || !compiled || !mediaReady || playbackFailed) return;
		let frame = 0;
		let disposed = false;
		let playPending = false;
		const tick = () => {
			if (disposed) return;
			const state = useProjectStore.getState();
			const clock = clockRef.current;
			const playing = state.playing && clock.isPlaying;
			const raw = playing ? clock.virtualTimeSec : state.currentTimeSec;
			const target = audioOutputTime(raw, compiled.clock);
			if (audio.readyState >= 1) {
				if (Math.abs(audio.currentTime - target) > (playing ? 0.08 : 0.01))
					audio.currentTime = target;
				// Music uses output seconds, so screen speed changes never change its pitch or rate.
				audio.playbackRate = 1;
				if (playing && audio.paused && !playPending && target < audio.duration) {
					playPending = true;
					void audio
						.play()
						.catch((error: unknown) => {
							if (disposed) return;
							const stopped = !useProjectStore.getState().playing || !clockRef.current.isPlaying;
							if (
								stopped &&
								typeof error === "object" &&
								error !== null &&
								"name" in error &&
								error.name === "AbortError"
							)
								return;
							setPlaybackFailed(true);
							useProjectStore.getState().setPlaying(false);
							setNotice(`Music playback failed: ${String(error)}`);
						})
						.finally(() => {
							playPending = false;
							if (disposed || !useProjectStore.getState().playing || !clockRef.current.isPlaying)
								audio.pause();
						});
				} else if (!playing) audio.pause();
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			audio.pause();
		};
	}, [sourceUrl, compiled, clockRef, mediaReady, playbackFailed]);
	if (!compiled) return null;
	return (
		<>
			{sourceUrl && (
				<audio
					ref={audioRef}
					src={sourceUrl}
					preload="auto"
					onCanPlay={() => {
						if (!playbackFailed) {
							setMediaReady(true);
							setNotice(null);
						}
					}}
					onWaiting={() => {
						setMediaReady(false);
						useProjectStore.getState().setPlaying(false);
						if (!playbackFailed) setNotice("Loading music and sound effects…");
					}}
					onError={() => {
						setPlaybackFailed(true);
						setMediaReady(false);
						useProjectStore.getState().setPlaying(false);
						setNotice("Music preview could not load. Import the source again and retry.");
					}}
				/>
			)}
			{notice && (
				<div
					role="status"
					style={{
						position: "absolute",
						bottom: 8,
						left: 8,
						right: 8,
						zIndex: 30,
						background: "#18181b",
						color: "#fafafa",
						padding: 8,
						borderRadius: 6,
						fontSize: 12,
					}}
				>
					{notice}
				</div>
			)}
		</>
	);
}

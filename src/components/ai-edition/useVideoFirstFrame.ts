import { useEffect, useState } from "react";

/** Gives up waiting so a slow or silent source never hides the preview for good. */
const FIRST_FRAME_TIMEOUT_MS = 6000;

/** True once the video can show its first frame, or failed to: either way, stop waiting. */
export function useVideoFirstFrame(video: HTMLVideoElement | null): boolean {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (!video) {
			setReady(false);
			return;
		}
		if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
			setReady(true);
			return;
		}
		setReady(false);
		const markReady = () => setReady(true);
		video.addEventListener("loadeddata", markReady);
		video.addEventListener("error", markReady);
		const timer = window.setTimeout(markReady, FIRST_FRAME_TIMEOUT_MS);
		return () => {
			video.removeEventListener("loadeddata", markReady);
			video.removeEventListener("error", markReady);
			window.clearTimeout(timer);
		};
	}, [video]);
	return ready;
}

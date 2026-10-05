import { useEffect, useState } from "react";

/** Gives up waiting so a slow or silent source never hides the preview for good. */
const FIRST_FRAME_TIMEOUT_MS = 6000;

/**
 * True once the video can show its current source's first frame, or failed to:
 * either way, stop waiting. A new source starts the wait again.
 */
export function useVideoFirstFrame(video: HTMLVideoElement | null): boolean {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (!video) {
			setReady(false);
			return;
		}
		let timer = 0;
		const markReady = () => {
			window.clearTimeout(timer);
			setReady(true);
		};
		const wait = () => {
			window.clearTimeout(timer);
			if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
				setReady(true);
				return;
			}
			setReady(false);
			timer = window.setTimeout(markReady, FIRST_FRAME_TIMEOUT_MS);
		};
		wait();
		video.addEventListener("loadstart", wait);
		video.addEventListener("loadeddata", markReady);
		video.addEventListener("error", markReady);
		return () => {
			video.removeEventListener("loadstart", wait);
			video.removeEventListener("loadeddata", markReady);
			video.removeEventListener("error", markReady);
			window.clearTimeout(timer);
		};
	}, [video]);
	return ready;
}

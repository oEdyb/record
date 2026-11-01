/** Further apart than this, playing or not, the camera jumps to the screen's moment. */
export const CAMERA_SEEK_DRIFT_SEC = 0.5;
/** Paused, a still camera frame this close to the screen's moment is the same frame. */
const PAUSED_DRIFT_SEC = 0.05;
/** How hard a playing camera leans toward the screen's moment, per second of drift. */
const RATE_GAIN = 2;
const MAX_RATE_NUDGE = 0.1;

export type CameraFollowAction =
	| { kind: "wait" }
	| { kind: "seek"; to: number }
	| { kind: "rate"; rate: number };

/**
 * The camera file is variable frame rate and WebM seeks are slow, so a playing camera that
 * seeks on every small drift lands behind again and never paints. Seek only on a real jump
 * or when paused; otherwise speed the camera up or slow it down until it catches up.
 */
export function cameraFollowAction(state: {
	cameraTime: number;
	targetTime: number;
	seeking: boolean;
	playing: boolean;
	baseRate: number;
}): CameraFollowAction {
	if (state.seeking) return { kind: "wait" };
	const drift = state.cameraTime - state.targetTime;
	if (
		Math.abs(drift) > CAMERA_SEEK_DRIFT_SEC ||
		(!state.playing && Math.abs(drift) > PAUSED_DRIFT_SEC)
	)
		return { kind: "seek", to: state.targetTime };
	if (!state.playing) return { kind: "rate", rate: state.baseRate };
	const nudge = Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, -drift * RATE_GAIN));
	return { kind: "rate", rate: state.baseRate * (1 + nudge) };
}

/** One animation-frame step: keep the camera on the screen video's moment and play state. */
export function followCamera(
	video: HTMLVideoElement,
	camera: HTMLVideoElement,
	offsetSec: number,
	play: (camera: HTMLVideoElement) => void,
) {
	if (camera.readyState < 1) return;
	const playing = !video.paused && !video.ended;
	const action = cameraFollowAction({
		cameraTime: camera.currentTime,
		targetTime: Math.max(0, video.currentTime - offsetSec),
		seeking: camera.seeking,
		playing,
		baseRate: video.playbackRate,
	});
	if (action.kind === "seek") camera.currentTime = action.to;
	if (action.kind === "rate" && Math.abs(camera.playbackRate - action.rate) > 0.005)
		camera.playbackRate = action.rate;
	if (!playing) {
		if (!camera.paused) camera.pause();
	} else if (camera.paused && !camera.ended) play(camera);
}

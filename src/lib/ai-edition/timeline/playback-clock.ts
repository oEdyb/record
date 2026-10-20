// Shared, ref-based playback clock written by the screen preview's rAF loop
// and read directly by any other media element that needs to stay in lockstep
// with it (currently: the webcam overlay).
//
// Why this exists: previously the webcam derived its sync target from a
// `currentTimeSec` PROP that traveled screen-video-rAF -> React state
// (VirtualPreview) -> onTimeChange callback -> React state (the editor shell)
// -> prop drilling back down through Preview/PreviewCanvas -> WebcamOverlay.
// Each hop adds a render pass of latency and makes the exact update cadence
// dependent on React's scheduling rather than the video's actual frame rate.
// Writing to a plain ref every rAF tick and reading it from the webcam's OWN
// rAF tick removes every one of those hops — the webcam sees the same value
// the screen just computed, this frame, with no React round trip at all.
export interface PlaybackClockSnapshot {
	/** Position on the edited/virtual timeline, in seconds. */
	virtualTimeSec: number;
	/** Position in the active screen source's own media time, in seconds. */
	sourceTimeSec: number;
	isPlaying: boolean;
	/** Active `<video>.playbackRate` for the screen source (speed regions). */
	playbackRate: number;
}

export type PlaybackClockRef = { current: PlaybackClockSnapshot };

export function createPlaybackClockRef(): PlaybackClockRef {
	return {
		current: { virtualTimeSec: 0, sourceTimeSec: 0, isPlaying: false, playbackRate: 1 },
	};
}

const clockListeners = new WeakMap<PlaybackClockRef, Set<() => void>>();

/** Calls `listener` whenever `publishPlaybackClock` changes the clock. */
export function onPlaybackClockChange(ref: PlaybackClockRef, listener: () => void): () => void {
	let listeners = clockListeners.get(ref);
	if (!listeners) {
		listeners = new Set();
		clockListeners.set(ref, listeners);
	}
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Writes this frame's clock and tells readers when it changed. Returns whether it did. */
export function publishPlaybackClock(ref: PlaybackClockRef, next: PlaybackClockSnapshot): boolean {
	const current = ref.current;
	const changed =
		current.virtualTimeSec !== next.virtualTimeSec ||
		current.sourceTimeSec !== next.sourceTimeSec ||
		current.isPlaying !== next.isPlaying ||
		current.playbackRate !== next.playbackRate;
	if (!changed) return false;
	Object.assign(current, next);
	for (const listener of clockListeners.get(ref) ?? []) listener();
	return true;
}

/** Paused and unchanged, a playback loop runs four times a second instead of on every
 *  display frame: a pending requestAnimationFrame alone keeps Chromium drawing at 60 Hz. */
export const IDLE_PLAYBACK_LOOP_MS = 250;
const QUIET_FRAMES_BEFORE_IDLE = 30;

export interface PlaybackLoop {
	/** Returns to display-frame ticks at once. */
	wake(): void;
	stop(): void;
}

/** Runs `frame` on every display frame while it reports activity, and every
 *  `IDLE_PLAYBACK_LOOP_MS` after 30 quiet frames until it reports activity or is woken. */
export function startPlaybackLoop(frame: () => boolean): PlaybackLoop {
	let raf = 0;
	let timer = 0;
	let quietFrames = 0;
	let stopped = false;
	const run = () => {
		raf = 0;
		let active = true;
		try {
			active = frame();
		} finally {
			quietFrames = active ? 0 : quietFrames + 1;
			if (!stopped) {
				if (quietFrames >= QUIET_FRAMES_BEFORE_IDLE) {
					timer = window.setTimeout(() => {
						timer = 0;
						raf = window.requestAnimationFrame(run);
					}, IDLE_PLAYBACK_LOOP_MS);
				} else {
					raf = window.requestAnimationFrame(run);
				}
			}
		}
	};
	raf = window.requestAnimationFrame(run);
	return {
		wake() {
			quietFrames = 0;
			if (timer === 0 || stopped) return;
			window.clearTimeout(timer);
			timer = 0;
			raf = window.requestAnimationFrame(run);
		},
		stop() {
			stopped = true;
			window.cancelAnimationFrame(raf);
			window.clearTimeout(timer);
		},
	};
}

// ponytail: mirrors main's VideoPlayback.tsx webcam-sync tolerances — tighter
// while paused (a still frame's exact position is visually obvious and a
// seek is cheap when nothing's moving) and looser while playing (a little
// slack avoids constant re-seeking/stutter that a viewer won't perceive as
// precisely during motion).
export const CAMERA_SYNC_TOLERANCE_PAUSED_SEC = 0.05;
export const CAMERA_SYNC_TOLERANCE_PLAYING_SEC = 0.15;

export interface CameraSyncTarget {
	targetTimeSec: number;
	playbackRate: number;
	isPlaying: boolean;
	toleranceSec: number;
}

/**
 * Pure core of the camera-sync tick: given this frame's clock snapshot and
 * the currently-active camera track/position (already resolved by the
 * caller from clips+assets), compute where the camera video should be and
 * how strict to be about correcting it. Kept separate from the rAF/DOM glue
 * in WebcamOverlay so the actual sync math is unit-testable without mounting
 * a component or a real <video> element.
 */
export function resolveCameraSyncTarget(
	clock: PlaybackClockSnapshot,
	cameraTrack: { startMs: number; offsetMs: number; visible: boolean } | null,
	sourceTimeSecForActiveClip: number | null,
): CameraSyncTarget | null {
	if (!cameraTrack?.visible || sourceTimeSecForActiveClip === null) return null;
	const offsetSec = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000;
	return {
		targetTimeSec: Math.max(0, sourceTimeSecForActiveClip - offsetSec),
		playbackRate: clock.playbackRate,
		isPlaying: clock.isPlaying,
		toleranceSec: clock.isPlaying
			? CAMERA_SYNC_TOLERANCE_PLAYING_SEC
			: CAMERA_SYNC_TOLERANCE_PAUSED_SEC,
	};
}

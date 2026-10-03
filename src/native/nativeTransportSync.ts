import type { CompositorFrameTiming } from "./contracts";

export interface NativeTransportTarget {
	viewId: number;
	sceneIdentity?: object;
	clipId: string;
	clipIndex: number;
	screenPath: string;
	webcamPath: string;
	webcamOffsetSec: number;
	sourceTimeSec: number;
	playing: boolean;
}

export interface NativeTransportSyncPolicy {
	/** Ignore normal readback/IPC latency and sub-frame clock noise. */
	maxDriftSec: number;
	/** Require several consecutive measurements so one delayed packet cannot seek playback. */
	driftFrames: number;
	/** Give an accepted seek time to publish before another correction is allowed. */
	resyncCooldownMs: number;
	/** A paused scrub below this delta is the same target, not another seek. */
	pausedSeekEpsilonSec: number;
}

export const DEFAULT_NATIVE_TRANSPORT_SYNC_POLICY: NativeTransportSyncPolicy = {
	maxDriftSec: 0.15,
	driftFrames: 3,
	resyncCooldownMs: 750,
	pausedSeekEpsilonSec: 0.001,
};

export interface TransportDriftState {
	consecutiveDriftFrames: number;
	lastResyncAtMs: number;
}

export function createTransportDriftState(lastResyncAtMs = Number.NEGATIVE_INFINITY) {
	return { consecutiveDriftFrames: 0, lastResyncAtMs } satisfies TransportDriftState;
}

/**
 * A playing media element updates source time every animation frame. Re-seeking
 * native for each update would turn sequential decode into random access. Only
 * discontinuities need a new atomic anchor; measured frame drift handles the
 * exceptional case where two running clocks separate afterwards.
 */
export function needsTransportSync(
	previous: NativeTransportTarget | null,
	next: NativeTransportTarget,
	policy: NativeTransportSyncPolicy = DEFAULT_NATIVE_TRANSPORT_SYNC_POLICY,
): boolean {
	if (!previous) return true;
	if (
		previous.viewId !== next.viewId ||
		previous.sceneIdentity !== next.sceneIdentity ||
		previous.clipId !== next.clipId ||
		previous.clipIndex !== next.clipIndex ||
		previous.screenPath !== next.screenPath ||
		previous.webcamPath !== next.webcamPath ||
		previous.webcamOffsetSec !== next.webcamOffsetSec ||
		previous.playing !== next.playing
	) {
		return true;
	}
	return (
		!next.playing &&
		Math.abs(previous.sourceTimeSec - next.sourceTimeSec) > policy.pausedSeekEpsilonSec
	);
}

export function observeTransportFrame(
	state: TransportDriftState,
	frame: CompositorFrameTiming,
	target: NativeTransportTarget,
	currentGeneration: number,
	nowMs: number,
	policy: NativeTransportSyncPolicy = DEFAULT_NATIVE_TRANSPORT_SYNC_POLICY,
): { state: TransportDriftState; shouldResync: boolean } {
	if (!target.playing || frame.transportGeneration !== currentGeneration) {
		return { state: createTransportDriftState(state.lastResyncAtMs), shouldResync: false };
	}

	const outOfSync =
		frame.clipIndex !== target.clipIndex ||
		Math.abs(frame.sourceTimeSec - target.sourceTimeSec) > policy.maxDriftSec;
	if (!outOfSync) {
		return { state: createTransportDriftState(state.lastResyncAtMs), shouldResync: false };
	}

	const nextState: TransportDriftState = {
		...state,
		consecutiveDriftFrames: state.consecutiveDriftFrames + 1,
	};
	const cooledDown = nowMs - state.lastResyncAtMs >= policy.resyncCooldownMs;
	return {
		state: nextState,
		shouldResync: cooledDown && nextState.consecutiveDriftFrames >= policy.driftFrames,
	};
}

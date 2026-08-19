import { useCallback, useEffect, useRef } from "react";
import { syncCompositorTransport } from "./compositorViewClient";
import type { CompositorFrameTiming } from "./contracts";
import {
	createTransportDriftState,
	type NativeTransportTarget,
	needsTransportSync,
	observeTransportFrame,
	type TransportDriftState,
} from "./nativeTransportSync";

/**
 * Keeps the native preview slaved to the media element's source-time clock.
 *
 * Normal playback stays sequential in native. We send one complete transport
 * anchor for a discontinuity (view/clip/play/pause/paused seek), then measure
 * the PTS native actually publishes. Sustained drift creates a fresh anchor;
 * ordinary renderer ticks never become expensive random-access seeks.
 */
export function useNativePlaybackSync(
	target: NativeTransportTarget | null,
): (frame: CompositorFrameTiming) => void {
	const targetRef = useRef(target);
	targetRef.current = target;
	const previousTargetRef = useRef<NativeTransportTarget | null>(null);
	const generationRef = useRef(0);
	const driftStateRef = useRef<TransportDriftState>(createTransportDriftState());

	const pushAnchor = useCallback((next: NativeTransportTarget, nowMs = performance.now()) => {
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		driftStateRef.current = createTransportDriftState(nowMs);
		void syncCompositorTransport({
			id: next.viewId,
			generation,
			playing: next.playing,
			clipIndex: next.clipIndex,
			screenPath: next.screenPath,
			webcamPath: next.webcamPath,
			webcamOffsetSec: next.webcamOffsetSec,
			sourceTimeSec: next.sourceTimeSec,
		}).catch((error: unknown) => {
			console.warn("[compositor-view] syncTransport failed:", error);
		});
	}, []);

	useEffect(() => {
		if (!target) {
			previousTargetRef.current = null;
			return;
		}
		if (needsTransportSync(previousTargetRef.current, target)) {
			pushAnchor(target);
		}
		previousTargetRef.current = target;
	}, [pushAnchor, target]);

	return useCallback(
		(frame: CompositorFrameTiming) => {
			const currentTarget = targetRef.current;
			if (!currentTarget) return;
			const observed = observeTransportFrame(
				driftStateRef.current,
				frame,
				currentTarget,
				generationRef.current,
				performance.now(),
			);
			driftStateRef.current = observed.state;
			if (observed.shouldResync) {
				pushAnchor(currentTarget);
			}
		},
		[pushAnchor],
	);
}

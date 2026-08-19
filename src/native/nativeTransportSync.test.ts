import { describe, expect, it } from "vitest";
import type { CompositorFrameTiming } from "./contracts";
import {
	createTransportDriftState,
	DEFAULT_NATIVE_TRANSPORT_SYNC_POLICY,
	type NativeTransportTarget,
	needsTransportSync,
	observeTransportFrame,
} from "./nativeTransportSync";

const target = (overrides: Partial<NativeTransportTarget> = {}): NativeTransportTarget => ({
	viewId: 7,
	clipId: "clip-a",
	clipIndex: 0,
	screenPath: "/recording/screen.mp4",
	webcamPath: "/recording/camera.mp4",
	webcamOffsetSec: 0.125,
	sourceTimeSec: 1.1,
	playing: false,
	...overrides,
});

const frame = (overrides: Partial<CompositorFrameTiming> = {}): CompositorFrameTiming => ({
	sourceTimeSec: 1.1,
	clipIndex: 0,
	transportGeneration: 1,
	...overrides,
});

describe("native transport target synchronization", () => {
	it("anchors a new view, clip changes, play transitions, and paused seeks", () => {
		const paused = target();
		expect(needsTransportSync(null, paused)).toBe(true);
		expect(needsTransportSync(paused, target({ sourceTimeSec: 1.2 }))).toBe(true);
		expect(needsTransportSync(paused, target({ playing: true }))).toBe(true);
		expect(needsTransportSync(paused, target({ clipId: "clip-b", clipIndex: 1 }))).toBe(true);
	});

	it("does not seek on each media-clock tick during normal playback", () => {
		const playing = target({ playing: true, sourceTimeSec: 1.1 });
		expect(needsTransportSync(playing, target({ playing: true, sourceTimeSec: 1.116 }))).toBe(
			false,
		);
	});
});

describe("native rendered-frame drift monitoring", () => {
	it("requires sustained measured drift before requesting a resync", () => {
		const playing = target({ playing: true, sourceTimeSec: 1.1 });
		let state = createTransportDriftState();

		for (let index = 0; index < DEFAULT_NATIVE_TRANSPORT_SYNC_POLICY.driftFrames - 1; index += 1) {
			const observed = observeTransportFrame(
				state,
				frame({ sourceTimeSec: 1.8 }),
				playing,
				1,
				1_000 + index * 33,
			);
			state = observed.state;
			expect(observed.shouldResync).toBe(false);
		}

		const observed = observeTransportFrame(state, frame({ sourceTimeSec: 1.8 }), playing, 1, 1_100);
		expect(observed.shouldResync).toBe(true);
	});

	it("ignores stale frames from the command that an atomic transport update replaced", () => {
		const observed = observeTransportFrame(
			createTransportDriftState(),
			frame({ sourceTimeSec: 1.8, transportGeneration: 3 }),
			target({ playing: true }),
			4,
			1_000,
		);

		expect(observed.shouldResync).toBe(false);
		expect(observed.state.consecutiveDriftFrames).toBe(0);
	});

	it("clears accumulated drift when a frame is back inside the allowed window", () => {
		const playing = target({ playing: true, sourceTimeSec: 1.1 });
		const first = observeTransportFrame(
			createTransportDriftState(),
			frame({ sourceTimeSec: 1.8 }),
			playing,
			1,
			1_000,
		);
		const recovered = observeTransportFrame(
			first.state,
			frame({ sourceTimeSec: 1.15 }),
			playing,
			1,
			1_033,
		);

		expect(recovered.shouldResync).toBe(false);
		expect(recovered.state.consecutiveDriftFrames).toBe(0);
	});
});

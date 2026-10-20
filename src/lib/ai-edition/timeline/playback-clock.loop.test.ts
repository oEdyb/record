// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPlaybackClockRef,
	IDLE_PLAYBACK_LOOP_MS,
	onPlaybackClockChange,
	publishPlaybackClock,
	startPlaybackLoop,
} from "./playback-clock";

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	frames = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		frames = [];
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function drawFrame() {
	const pending = frames;
	frames = [];
	for (const callback of pending) callback(0);
}

describe("publishPlaybackClock", () => {
	it("tells readers only when the clock moves", () => {
		const ref = createPlaybackClockRef();
		const listener = vi.fn();
		const stop = onPlaybackClockChange(ref, listener);
		const still = { virtualTimeSec: 0, sourceTimeSec: 0, isPlaying: false, playbackRate: 1 };

		expect(publishPlaybackClock(ref, still)).toBe(false);
		expect(publishPlaybackClock(ref, { ...still, sourceTimeSec: 2 })).toBe(true);
		expect(ref.current.sourceTimeSec).toBe(2);
		expect(listener).toHaveBeenCalledTimes(1);
		stop();
		publishPlaybackClock(ref, { ...still, sourceTimeSec: 3 });
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("startPlaybackLoop", () => {
	it("stops requesting display frames after 30 quiet frames and wakes at once", () => {
		let active = false;
		const frame = vi.fn(() => active);
		const loop = startPlaybackLoop(frame);

		for (let i = 0; i < 30; i += 1) drawFrame();
		expect(frame).toHaveBeenCalledTimes(30);
		expect(frames).toHaveLength(0);
		vi.advanceTimersByTime(IDLE_PLAYBACK_LOOP_MS - 1);
		expect(frames).toHaveLength(0);
		vi.advanceTimersByTime(1);
		drawFrame();
		expect(frame).toHaveBeenCalledTimes(31);
		expect(frames).toHaveLength(0);

		loop.wake();
		expect(frames).toHaveLength(1);
		active = true;
		drawFrame();
		drawFrame();
		expect(frames).toHaveLength(1);
		loop.stop();
		vi.advanceTimersByTime(IDLE_PLAYBACK_LOOP_MS * 4);
		expect(frames).toHaveLength(0);
	});

	it("keeps running when a frame throws", () => {
		const loop = startPlaybackLoop(() => {
			throw new Error("frame failed");
		});
		expect(() => drawFrame()).toThrow("frame failed");
		expect(frames).toHaveLength(1);
		loop.stop();
	});
});

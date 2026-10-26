import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHudPointerWatch } from "./hudPointerWatch";

function setup(platform: NodeJS.Platform = "darwin") {
	const state: { visible: boolean; dragging: boolean; point: { x: number; y: number } | null } = {
		visible: true,
		dragging: false,
		point: { x: 32, y: 20 },
	};
	const onProbe = vi.fn();
	const onOutside = vi.fn();
	const readPoint = vi.fn(() => state.point);
	const watch = createHudPointerWatch({
		platform,
		isVisible: () => state.visible,
		isDragging: () => state.dragging,
		readPoint,
		onProbe,
		onOutside,
	});
	return { state, watch, onProbe, onOutside, readPoint };
}

describe("visible HUD cursor probes", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it.each([
		"darwin",
		"win32",
	] as const)("delivers a stationary cursor without DOM input on %s", (platform) => {
		const { watch, onProbe } = setup(platform);
		watch.start();
		expect(onProbe).toHaveBeenLastCalledWith({ x: 32, y: 20 });
		vi.advanceTimersByTime(80);
		expect(onProbe).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(40);
		expect(onProbe).toHaveBeenCalledTimes(2);
		watch.stop();
	});

	it("keeps checking and reports null when the cursor leaves a click-through window", () => {
		const { watch, state, onProbe, onOutside } = setup();
		watch.start();
		state.point = null;
		vi.advanceTimersByTime(40);
		expect(onProbe).toHaveBeenLastCalledWith(null);
		expect(onOutside).toHaveBeenCalledOnce();
		state.point = { x: 20, y: 10 };
		vi.advanceTimersByTime(40);
		expect(onProbe).toHaveBeenLastCalledWith(state.point);
		watch.stop();
	});

	it("does not duplicate timers and forces a sample for a visible renderer reload", () => {
		const { watch, readPoint, onProbe } = setup();
		watch.start();
		watch.start();
		expect(vi.getTimerCount()).toBe(1);
		expect(onProbe).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(40);
		expect(readPoint).toHaveBeenCalledTimes(3);
		watch.stop();
	});

	it("reads no cursor and sends no probes while hidden, recovering without a show event", () => {
		const { watch, state, onProbe, readPoint } = setup();
		watch.start();
		state.visible = false;
		vi.advanceTimersByTime(400);
		expect(vi.getTimerCount()).toBe(1);
		expect(onProbe).toHaveBeenCalledOnce();
		expect(readPoint).toHaveBeenCalledOnce();
		state.visible = true;
		vi.advanceTimersByTime(40);
		expect(onProbe).toHaveBeenCalledTimes(2);
		watch.stop();
	});

	it("samples after a show event fires before native visibility flips", () => {
		const { watch, state, onProbe } = setup();
		state.visible = false;
		watch.start();
		expect(onProbe).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		state.visible = true;
		vi.advanceTimersByTime(40);
		expect(onProbe).toHaveBeenCalledExactlyOnceWith(state.point);
		watch.stop();
	});

	it("cancels a pending show when lifecycle teardown arrives first", () => {
		const { watch, state, onProbe } = setup();
		state.visible = false;
		watch.start();
		watch.stop();
		state.visible = true;
		vi.advanceTimersByTime(80);
		expect(onProbe).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops immediately on lifecycle teardown", () => {
		const { watch, onProbe } = setup();
		watch.start();
		watch.stop();
		vi.advanceTimersByTime(500);
		expect(vi.getTimerCount()).toBe(0);
		expect(onProbe).toHaveBeenCalledOnce();
	});

	it("suspends probes during drag", () => {
		const { watch, state, onProbe } = setup();
		state.dragging = true;
		watch.start();
		vi.advanceTimersByTime(200);
		expect(onProbe).not.toHaveBeenCalled();
		state.dragging = false;
		vi.advanceTimersByTime(40);
		expect(onProbe).toHaveBeenCalledOnce();
		watch.stop();
	});

	it("leaves Linux input handling unchanged", () => {
		const { watch, onProbe } = setup("linux");
		watch.start();
		vi.advanceTimersByTime(200);
		expect(onProbe).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

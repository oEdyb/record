import { afterEach, expect, it, vi } from "vitest";
import { WindowFade } from "./windowFade";

afterEach(() => vi.useRealTimers());
it("retargets the current opacity and cancels stale completions", () => {
	vi.useFakeTimers();
	let opacity = 1;
	const window = {
		isDestroyed: () => false,
		getOpacity: () => opacity,
		setOpacity: (value: number) => {
			opacity = value;
		},
	};
	const fade = new WindowFade(() => true);
	const hidden = vi.fn();
	fade.to(window, 0, 120, hidden);
	vi.advanceTimersByTime(48);
	const current = opacity;
	fade.to(window, 1, 180);
	expect(opacity).toBe(current);
	vi.advanceTimersByTime(32);
	fade.to(window, 0, 120, hidden);
	vi.advanceTimersByTime(200);
	expect(opacity).toBe(0);
	expect(hidden).toHaveBeenCalledOnce();
	fade.to(window, 1, 180);
	vi.advanceTimersByTime(200);
	expect(opacity).toBe(1);
});
it("completes instantly when motion is disabled", () => {
	const setOpacity = vi.fn();
	const done = vi.fn();
	new WindowFade(() => false).to({ isDestroyed: () => false, setOpacity }, 1, 180, done);
	expect(setOpacity).toHaveBeenCalledWith(1);
	expect(done).toHaveBeenCalledOnce();
});

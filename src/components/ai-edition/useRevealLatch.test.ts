// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRevealLatch } from "./useRevealLatch";

const render = (key: string | null, ready: boolean, reset = false) =>
	renderHook(({ key, ready, reset }) => useRevealLatch(key, ready, reset), {
		initialProps: { key, ready, reset },
	});

describe("useRevealLatch", () => {
	it("stays revealed through seeks and clip switches after the first frame", () => {
		const hook = render("a", false);
		expect(hook.result.current).toBe(false);
		hook.rerender({ key: "a", ready: true, reset: false });
		expect(hook.result.current).toBe(true);
		hook.rerender({ key: "a", ready: false, reset: false });
		expect(hook.result.current).toBe(true);
	});

	it("waits for a new recording's own first frame", () => {
		const hook = render("a", false);
		hook.rerender({ key: "a", ready: true, reset: false });
		hook.rerender({ key: "b", ready: true, reset: false });
		hook.rerender({ key: "b", ready: false, reset: false });
		expect(hook.result.current).toBe(false);
		hook.rerender({ key: "b", ready: true, reset: false });
		hook.rerender({ key: "b", ready: false, reset: false });
		expect(hook.result.current).toBe(true);
	});

	it("follows readiness again after a reset, then latches", () => {
		const hook = render("a", false);
		hook.rerender({ key: "a", ready: true, reset: false });
		hook.rerender({ key: "a", ready: false, reset: true });
		expect(hook.result.current).toBe(false);
		hook.rerender({ key: "a", ready: false, reset: false });
		expect(hook.result.current).toBe(false);
		hook.rerender({ key: "a", ready: true, reset: false });
		hook.rerender({ key: "a", ready: false, reset: false });
		expect(hook.result.current).toBe(true);
	});
});

describe("useRevealLatch give-up", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const renderWithGiveUp = (key: string | null, ready: boolean, reset = false) =>
		renderHook(({ key, ready, reset }) => useRevealLatch(key, ready, reset, 6000), {
			initialProps: { key, ready, reset },
		});

	it("reveals a key whose preview never becomes ready, and keeps it revealed", () => {
		vi.useFakeTimers();
		const hook = renderWithGiveUp("a", false);
		act(() => {
			vi.advanceTimersByTime(5999);
		});
		expect(hook.result.current).toBe(false);
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(hook.result.current).toBe(true);
		hook.rerender({ key: "a", ready: false, reset: false });
		expect(hook.result.current).toBe(true);
	});

	it("does not carry a give-up over to the next recording", () => {
		vi.useFakeTimers();
		const hook = renderWithGiveUp("a", false);
		act(() => {
			vi.advanceTimersByTime(6000);
		});
		expect(hook.result.current).toBe(true);
		hook.rerender({ key: "b", ready: false, reset: false });
		expect(hook.result.current).toBe(false);
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(hook.result.current).toBe(false);
	});

	it("covers again for the recorder and does not give up while leaving", () => {
		vi.useFakeTimers();
		const hook = renderWithGiveUp("a", false);
		hook.rerender({ key: "a", ready: true, reset: false });
		hook.rerender({ key: "a", ready: false, reset: true });
		act(() => {
			vi.advanceTimersByTime(10000);
		});
		expect(hook.result.current).toBe(false);
	});
});

// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

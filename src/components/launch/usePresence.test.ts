// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./usePresence";

afterEach(() => vi.useRealTimers());

describe("usePresence", () => {
	it("stays mounted while closing, then unmounts", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(({ open }) => usePresence(open, 120), {
			initialProps: { open: true },
		});
		expect(result.current).toEqual({ present: true, closing: false });

		rerender({ open: false });
		expect(result.current).toEqual({ present: true, closing: true });

		act(() => vi.advanceTimersByTime(120));
		expect(result.current).toEqual({ present: false, closing: false });
	});

	it("reopening during the exit cancels it", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(({ open }) => usePresence(open, 120), {
			initialProps: { open: true },
		});
		rerender({ open: false });
		act(() => vi.advanceTimersByTime(60));
		rerender({ open: true });
		act(() => vi.advanceTimersByTime(120));
		expect(result.current).toEqual({ present: true, closing: false });
	});
});

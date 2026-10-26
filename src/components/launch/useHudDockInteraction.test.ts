// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHudDockInteraction } from "./useHudDockInteraction";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function setup() {
	return renderHook((options) => useHudDockInteraction(options), {
		initialProps: { docked: true, dragging: false, panelOpen: false },
	});
}
function advance(ms: number) {
	act(() => vi.advanceTimersByTime(ms));
}

describe("useHudDockInteraction", () => {
	it("does not reopen when spring undershoot crosses a stationary cursor after explicit collapse", () => {
		const { result } = setup();
		act(() => result.current.samplePointer(true));
		advance(120);
		act(() => result.current.collapse());
		advance(280);
		act(() => result.current.samplePointer(false));
		advance(160);
		act(() => result.current.samplePointer(true));
		advance(1000);
		expect(result.current.expanded).toBe(false);
		act(() => result.current.samplePointer(false));
		act(() => result.current.samplePointer(true));
		advance(120);
		expect(result.current.expanded).toBe(true);
	});

	it("opens from stationary native samples without a DOM entry, without extending the deadline", () => {
		const { result } = setup();
		act(() => result.current.samplePointer(true));
		for (let i = 0; i < 3; i++) {
			advance(40);
			act(() => result.current.samplePointer(true));
		}
		expect(result.current.expanded).toBe(true);
		advance(2000);
		expect(result.current.expanded).toBe(true);
	});

	it("cancels passing hover and preserves the leave deadline across stationary outside samples", () => {
		const { result } = setup();
		act(() => result.current.samplePointer(true));
		advance(80);
		act(() => result.current.samplePointer(false));
		advance(200);
		expect(result.current.expanded).toBe(false);
		act(() => result.current.samplePointer(true));
		advance(120);
		act(() => result.current.samplePointer(false));
		for (let i = 0; i < 6; i++) {
			advance(40);
			act(() => result.current.samplePointer(false));
		}
		expect(result.current.expanded).toBe(true);
		advance(40);
		expect(result.current.expanded).toBe(false);
	});

	it("reverses immediately during leave grace and the closing motion", () => {
		const { result } = setup();
		act(() => result.current.samplePointer(true));
		advance(120);
		act(() => result.current.samplePointer(false));
		advance(200);
		act(() => result.current.samplePointer(true));
		advance(200);
		expect(result.current.expanded).toBe(true);
		act(() => result.current.samplePointer(false));
		advance(280);
		expect(result.current.expanded).toBe(false);
		advance(100);
		act(() => result.current.samplePointer(true));
		expect(result.current.expanded).toBe(true);
	});

	it("restores intent delay after closing settles", () => {
		const { result } = setup();
		act(() => result.current.samplePointer(true));
		advance(120);
		act(() => result.current.samplePointer(false));
		advance(280);
		advance(600);
		act(() => result.current.samplePointer(true));
		expect(result.current.expanded).toBe(false);
		advance(120);
		expect(result.current.expanded).toBe(true);
	});

	it("pins attached expansion and toggles it closed", () => {
		const { result } = setup();
		act(() => result.current.togglePinned());
		expect(result.current.pinned).toBe(true);
		advance(2000);
		expect(result.current.expanded).toBe(true);
		act(() => result.current.togglePinned());
		expect(result.current.pinned).toBe(false);
		expect(result.current.expanded).toBe(false);
	});

	it("holds focus until focus leaves", () => {
		const { result } = setup();
		act(() => result.current.setFocusWithin(true));
		advance(2000);
		expect(result.current.expanded).toBe(true);
		act(() => result.current.setFocusWithin(false));
		advance(279);
		expect(result.current.expanded).toBe(true);
		advance(1);
		expect(result.current.expanded).toBe(false);
	});

	it.each<{ hold: "panelOpen" | "dragging" }>([
		{ hold: "panelOpen" },
		{ hold: "dragging" },
	])("holds $hold independently of the pointer", ({ hold }) => {
		const { result, rerender } = setup();
		rerender({ docked: true, dragging: false, panelOpen: false, [hold]: true });
		advance(2000);
		expect(result.current.expanded).toBe(true);
		rerender({ docked: true, dragging: false, panelOpen: false });
		advance(280);
		expect(result.current.expanded).toBe(false);
	});

	it("explicit collapse clears pin and resists stationary hover until leave and re-entry", () => {
		const { result } = setup();
		act(() => {
			result.current.samplePointer(true);
			result.current.togglePinned();
			result.current.setFocusWithin(true);
		});
		act(() => result.current.collapse());
		for (let i = 0; i < 30; i++) {
			advance(40);
			act(() => result.current.samplePointer(true));
		}
		expect(result.current.expanded).toBe(false);
		expect(result.current.pinned).toBe(false);
		act(() => result.current.samplePointer(false));
		act(() => result.current.samplePointer(true));
		advance(120);
		expect(result.current.expanded).toBe(true);
	});

	it("undocking cancels deadlines, focus, suppression and pin", () => {
		const { result, rerender } = setup();
		act(() => result.current.togglePinned());
		rerender({ docked: false, dragging: false, panelOpen: false });
		advance(2000);
		expect(result.current.expanded).toBe(false);
		expect(result.current.pinned).toBe(false);
		rerender({ docked: true, dragging: false, panelOpen: false });
		act(() => result.current.samplePointer(true));
		expect(result.current.expanded).toBe(false);
		advance(120);
		expect(result.current.expanded).toBe(true);
	});

	it("keeps expansion while another hold remains and cancels a pending close for a new hold", () => {
		const { result, rerender } = setup();
		act(() => result.current.setFocusWithin(true));
		rerender({ docked: true, dragging: false, panelOpen: true });
		act(() => result.current.setFocusWithin(false));
		advance(1000);
		expect(result.current.expanded).toBe(true);
		rerender({ docked: true, dragging: false, panelOpen: false });
		advance(200);
		rerender({ docked: true, dragging: true, panelOpen: false });
		advance(1000);
		expect(result.current.expanded).toBe(true);
	});

	it("does not let an existing panel hold undo explicit collapse", () => {
		const { result, rerender } = setup();
		rerender({ docked: true, dragging: false, panelOpen: true });
		act(() => result.current.collapse());
		advance(1000);
		expect(result.current.expanded).toBe(false);
		rerender({ docked: true, dragging: false, panelOpen: false });
		rerender({ docked: true, dragging: false, panelOpen: true });
		expect(result.current.expanded).toBe(true);
	});

	it("allows the next entry after collapse when the cursor was already outside", () => {
		const { result } = setup();
		act(() => result.current.togglePinned());
		act(() => result.current.collapse());
		advance(600);
		act(() => result.current.samplePointer(true));
		advance(120);
		expect(result.current.expanded).toBe(true);
	});

	it("uses the supplied motion duration before restoring hover dwell", () => {
		const { result } = renderHook(() =>
			useHudDockInteraction({
				docked: true,
				dragging: false,
				panelOpen: false,
				closeDurationMs: 200,
			}),
		);
		act(() => result.current.samplePointer(true));
		advance(120);
		act(() => result.current.samplePointer(false));
		advance(280);
		advance(200);
		act(() => result.current.samplePointer(true));
		expect(result.current.expanded).toBe(false);
		advance(120);
		expect(result.current.expanded).toBe(true);
	});

	it("clears pending timers on unmount", () => {
		const { result, unmount } = setup();
		act(() => result.current.samplePointer(true));
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});

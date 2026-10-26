// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import styles from "./LaunchWindow.module.css";
import { useLinuxHudGeometry } from "./useLinuxHudGeometry";

const report = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
		window.setTimeout(() => callback(0), 16),
	);
	vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
	report.mockClear();
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { getPlatform: () => "linux", setHudDirectionExclusionRectangles: report },
	});
});

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function fixture() {
	const anchor = document.createElement("div");
	anchor.className = styles.hudAnchor;
	const bar = document.createElement("div");
	bar.className = styles.hudBar;
	bar.dataset.hudInteractive = "true";
	anchor.append(bar);
	document.body.append(anchor);
	vi.spyOn(bar, "offsetWidth", "get").mockReturnValue(424);
	vi.spyOn(bar, "getBoundingClientRect").mockImplementation(
		() =>
			new DOMRect(
				Number.parseFloat(anchor.style.left),
				Number.parseFloat(anchor.style.top),
				424,
				50,
			),
	);
	return { anchor, bar };
}

async function flushLayout() {
	await act(async () => {
		await Promise.resolve();
		vi.advanceTimersByTime(16);
	});
}

describe("Linux local HUD layout", () => {
	it("pins the pill independently of viewport resizing and keeps the idle allocation compact", async () => {
		const { anchor } = fixture();
		renderHook(useLinuxHudGeometry);
		expect(anchor.style.transform).toBe("none");
		expect(report).toHaveBeenLastCalledWith([{ x: 24, y: 38, width: 424, height: 50 }]);
		const calls = report.mock.calls.length;
		window.dispatchEvent(new Event("resize"));
		await flushLayout();
		expect(report).toHaveBeenCalledTimes(calls);
	});

	it("fits the actual stack above the pill and releases its reserve when it unmounts", async () => {
		const { anchor } = fixture();
		renderHook(useLinuxHudGeometry);
		const stack = document.createElement("div");
		stack.className = styles.hudAbove;
		vi.spyOn(stack, "offsetWidth", "get").mockReturnValue(652);
		vi.spyOn(stack, "offsetHeight", "get").mockReturnValue(400);
		const panel = document.createElement("div");
		panel.dataset.hudInteractive = "true";
		vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
			() =>
				new DOMRect(
					Number.parseFloat(anchor.style.left) - 114,
					Number.parseFloat(anchor.style.top) - 408,
					652,
					400,
				),
		);
		stack.append(panel);
		anchor.append(stack);
		await flushLayout();
		expect(report).toHaveBeenLastCalledWith([
			{ x: 138, y: 432, width: 424, height: 50 },
			{ x: 24, y: 24, width: 652, height: 400 },
		]);
		stack.remove();
		await flushLayout();
		expect(report).toHaveBeenLastCalledWith([{ x: 24, y: 38, width: 424, height: 50 }]);
	});

	it("includes portaled select menus and toasts in the input window", async () => {
		fixture();
		renderHook(useLinuxHudGeometry);
		const menu = document.createElement("div");
		menu.dataset.klipptSelectContent = "";
		vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 100, 220, 240));
		const toast = document.createElement("li");
		toast.dataset.sonnerToast = "";
		vi.spyOn(toast, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 100, 360, 60));
		document.body.append(menu, toast);
		await flushLayout();
		expect(report).toHaveBeenLastCalledWith([
			{ x: 24, y: 38, width: 424, height: 50 },
			{ x: 400, y: 100, width: 220, height: 240 },
			{ x: 24, y: 100, width: 360, height: 60 },
		]);
	});

	it.each(["darwin", "win32"])("leaves %s layout and geometry reporting untouched", (platform) => {
		Object.defineProperty(window, "electronAPI", {
			value: { getPlatform: () => platform, setHudDirectionExclusionRectangles: report },
		});
		const { anchor } = fixture();
		renderHook(useLinuxHudGeometry);
		expect(anchor.getAttribute("style")).toBeNull();
		expect(report).not.toHaveBeenCalled();
	});

	it("clears scheduled work and restores the anchor on unmount", async () => {
		const { anchor } = fixture();
		const { unmount } = renderHook(useLinuxHudGeometry);
		window.dispatchEvent(new Event("resize"));
		unmount();
		expect(anchor.getAttribute("style")).toBeNull();
		report.mockClear();
		await flushLayout();
		expect(report).not.toHaveBeenCalled();
	});
});

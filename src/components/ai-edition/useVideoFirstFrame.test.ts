// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVideoFirstFrame } from "./useVideoFirstFrame";

describe("useVideoFirstFrame", () => {
	afterEach(() => vi.useRealTimers());

	it("waits for the first frame, then reports ready", () => {
		const video = document.createElement("video");
		const { result } = renderHook(() => useVideoFirstFrame(video));
		expect(result.current).toBe(false);
		act(() => {
			video.dispatchEvent(new Event("loadeddata"));
		});
		expect(result.current).toBe(true);
	});

	it("stops waiting when the video fails or never answers", () => {
		vi.useFakeTimers();
		const failing = document.createElement("video");
		const failed = renderHook(() => useVideoFirstFrame(failing));
		act(() => {
			failing.dispatchEvent(new Event("error"));
		});
		expect(failed.result.current).toBe(true);

		const quiet = document.createElement("video");
		const silent = renderHook(() => useVideoFirstFrame(quiet));
		expect(silent.result.current).toBe(false);
		act(() => {
			vi.advanceTimersByTime(6000);
		});
		expect(silent.result.current).toBe(true);
	});

	it("waits again when the same video loads a new recording", () => {
		const video = document.createElement("video");
		const { result } = renderHook(() => useVideoFirstFrame(video));
		act(() => {
			video.dispatchEvent(new Event("loadeddata"));
		});
		expect(result.current).toBe(true);
		act(() => {
			video.dispatchEvent(new Event("loadstart"));
		});
		expect(result.current).toBe(false);
		act(() => {
			video.dispatchEvent(new Event("loadeddata"));
		});
		expect(result.current).toBe(true);
	});
});

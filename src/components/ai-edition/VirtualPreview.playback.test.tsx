// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import type { AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

// The rAF tick is the whole subject here, so it is driven by hand rather than by the
// browser: `tick()` runs exactly one frame, which is what makes "what did the loop decide
// at 9.96 s?" an assertion instead of a race.
let frameCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
	frameCallbacks = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		frameCallbacks.push(cb);
		return frameCallbacks.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		// Frames are drained by `tick()`, never scheduled, so there is nothing to cancel —
		// the stub only exists so the effect's cleanup has something to call.
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function tick() {
	const pending = frameCallbacks;
	frameCallbacks = [];
	act(() => {
		for (const cb of pending) cb(0);
	});
}

function clip(
	id: string,
	assetId: string,
	sourceStartSec: number,
	sourceEndSec: number,
	timelineStartSec: number,
): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

/** A `<video>` jsdom will not drive: its clock is set by the test, and play/pause are
 *  recorded rather than performed (jsdom implements neither). */
function driveVideo(element: HTMLVideoElement) {
	let currentTime = 0;
	let paused = true;
	const pauseCalls: number[] = [];
	Object.defineProperty(element, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
		},
	});
	Object.defineProperty(element, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 });
	Object.defineProperty(element, "duration", { configurable: true, get: () => 10 });
	element.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	element.pause = vi.fn(() => {
		paused = true;
		pauseCalls.push(currentTime);
	});
	return {
		pauseCalls,
		play: () => {
			paused = false;
		},
		seekTo: (next: number) => {
			currentTime = next;
		},
		get currentTime() {
			return currentTime;
		},
	};
}

function driveAudio(element: HTMLAudioElement) {
	let currentTime = 0;
	let paused = true;
	Object.defineProperty(element, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
		},
	});
	Object.defineProperty(element, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(element, "duration", { configurable: true, get: () => 10 });
	element.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	element.pause = vi.fn(() => {
		paused = true;
	});
	return {
		get currentTime() {
			return currentTime;
		},
	};
}

function mount(clips: AxcutClip[], trimRanges: AxcutTrimRange[] = []) {
	const onTimeChange = vi.fn();
	const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
	const { container } = render(
		<VirtualPreview
			videoSources={sources}
			clips={clips}
			trimRanges={trimRanges}
			onTimeChange={onTimeChange}
		/>,
	);
	const element = container.querySelector("video");
	if (!element) throw new Error("no <video> rendered");
	const video = driveVideo(element as HTMLVideoElement);
	// How the real app resolves its first clip: metadata arrives, the component seeks to
	// its current virtual time, and that seek is what names the active clip.
	act(() => {
		fireEvent.loadedMetadata(element);
	});
	return { onTimeChange, video, element: element as HTMLVideoElement };
}

const reportedTimes = (onTimeChange: ReturnType<typeof vi.fn>) =>
	onTimeChange.mock.calls.map((call) => call[0] as number);

describe("VirtualPreview playback across a clip boundary", () => {
	it("uses the ready Clean Voice mix as one synced audio route and falls back as a whole", () => {
		const sources: VideoSource[] = [
			{
				id: "a1",
				src: "file:///tmp/a1.mp4",
				audioSrc: "file:///tmp/a1-clean.m4a",
				label: "a1",
			},
		];
		const { container } = render(
			<VirtualPreview videoSources={sources} clips={[clip("clip_1", "a1", 0, 10, 0)]} />,
		);
		const videoElement = container.querySelector("video") as HTMLVideoElement;
		const audioElement = container.querySelector("audio") as HTMLAudioElement;
		const video = driveVideo(videoElement);
		const audio = driveAudio(audioElement);
		act(() => {
			fireEvent.loadedMetadata(videoElement);
			fireEvent.canPlay(audioElement);
		});

		video.play();
		video.seekTo(5);
		tick();
		expect(videoElement.muted).toBe(true);
		expect(audio.currentTime).toBe(5);
		expect(audioElement.play).toHaveBeenCalled();

		act(() => fireEvent.error(audioElement));
		expect(videoElement.muted).toBe(false);
	});

	// The reported bug: with two clips over ONE recording, playback stopped on reaching
	// the second clip and the playhead landed at the end of the timeline.
	it("crosses into the second clip of the same recording instead of stopping", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const { onTimeChange, video } = mount(clips);

		video.play();
		// Play out clip_1 up to the frame where the boundary advance fires.
		for (const t of [1, 5, 9, 9.96]) {
			video.seekTo(t);
			tick();
		}

		expect(video.pauseCalls).toHaveLength(0);
		// The playhead must never have been reported inside clip_2's span, let alone at the
		// end of the timeline (20), while clip_1 was still playing.
		expect(Math.max(...reportedTimes(onTimeChange))).toBeLessThanOrEqual(10.001);
		// …and the advance rewound the media to clip_2's source in-point and kept playing.
		expect(video.currentTime).toBe(0);
		expect(reportedTimes(onTimeChange).at(-1)).toBeCloseTo(10, 5);

		// Now play clip_2 out; only NOW may playback stop, at the end of the timeline.
		for (const t of [1, 5, 9.96]) {
			video.seekTo(t);
			tick();
		}
		expect(video.pauseCalls).toHaveLength(1);
		expect(reportedTimes(onTimeChange).at(-1)).toBeCloseTo(20, 5);
	});

	it("crosses the boundary the same way whatever order the clips are laid in", () => {
		// The layout that used to escape the bug (a foreign clip last) and the ones that did
		// not must now behave identically.
		const layouts: Array<[string, AxcutClip[]]> = [
			[
				"twins then a foreign clip",
				[clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
			],
			[
				"a foreign clip between the twins",
				[
					clip("clip_1", "a1", 0, 10, 0),
					clip("clip_3", "c1", 0, 10, 10),
					clip("clip_2", "a1", 0, 10, 20),
				],
			],
		];
		for (const [label, clips] of layouts) {
			const { onTimeChange, video } = mount(clips);
			video.play();
			for (const t of [5, 9.96]) {
				video.seekTo(t);
				tick();
			}
			expect(video.pauseCalls, label).toHaveLength(0);
			expect(Math.max(...reportedTimes(onTimeChange)), label).toBeLessThanOrEqual(10.001);
			cleanup();
		}
	});

	it("skips a cut authored on the playing clip even when its twin keeps that stretch", () => {
		// clip_1 cuts source 4–6; clip_2 is the same recording, uncut. The cut must apply
		// while clip_1 plays — the twin keeping the stretch used to answer for it.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const trims: AxcutTrimRange[] = [
			{
				id: "trim_1",
				assetId: "a1",
				clipId: "clip_1",
				startSec: 4,
				endSec: 6,
				origin: "user",
				reason: "",
			},
		];
		const { video } = mount(clips, trims);

		video.play();
		video.seekTo(3);
		tick();
		expect(video.currentTime).toBe(3); // before the cut: untouched

		video.seekTo(5); // inside clip_1's cut
		tick();
		expect(video.currentTime).toBe(6); // jumped to where clip_1's content resumes
		expect(video.pauseCalls).toHaveLength(0);
	});

	it("uses the editor playhead when metadata reloads after a timeline edit", () => {
		const before = [clip("clip_1", "a1", 0, 10, 0)];
		const after = [clip("clip_1", "a1", 0, 6, 0)];
		const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
		const onTimeChange = vi.fn();
		const seekTarget = { timeSec: 8, requestId: 1 };
		const { container, rerender } = render(
			<VirtualPreview
				videoSources={sources}
				clips={before}
				currentTimeSec={0}
				onTimeChange={onTimeChange}
			/>,
		);
		const element = container.querySelector("video");
		if (!element) throw new Error("no <video> rendered");
		driveVideo(element);
		act(() => fireEvent.loadedMetadata(element));

		// Move the preview's internal clock to 8 s, then remove content and place
		// the editor playhead at the resulting 4 s insertion boundary. A source
		// reload must not replay the stale 8 s clock and clamp it to the new end.
		rerender(
			<VirtualPreview
				videoSources={sources}
				clips={before}
				currentTimeSec={8}
				seekTarget={seekTarget}
				onTimeChange={onTimeChange}
			/>,
		);
		onTimeChange.mockClear();
		rerender(
			<VirtualPreview
				videoSources={sources}
				clips={after}
				currentTimeSec={4}
				seekTarget={seekTarget}
				onTimeChange={onTimeChange}
			/>,
		);
		act(() => fireEvent.loadedMetadata(element));

		expect(onTimeChange).toHaveBeenLastCalledWith(4);
	});
});

describe("VirtualPreview seek while playing", () => {
	it("keeps playing from the new spot when the playhead is moved into another clip", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)];
		const sources: VideoSource[] = [
			{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" },
			{ id: "a2", src: "file:///tmp/a2.mp4", label: "a2" },
		];
		const onTimeChange = vi.fn();
		const { container, rerender } = render(
			<VirtualPreview videoSources={sources} clips={clips} onTimeChange={onTimeChange} />,
		);
		const first = container.querySelector("video") as HTMLVideoElement;
		const firstVideo = driveVideo(first);
		act(() => fireEvent.loadedMetadata(first));
		firstVideo.play();
		firstVideo.seekTo(2);
		tick();

		rerender(
			<VirtualPreview
				videoSources={sources}
				clips={clips}
				seekTarget={{ timeSec: 13, requestId: 1 }}
				onTimeChange={onTimeChange}
			/>,
		);
		const second = container.querySelector("video") as HTMLVideoElement;
		expect(second).not.toBe(first);
		driveVideo(second);
		act(() => fireEvent.loadedMetadata(second));
		expect(second.currentTime).toBe(3);
		expect(second.play).toHaveBeenCalled();
	});

	it("hands the parent the video element that is on screen after an asset switch", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)];
		const sources: VideoSource[] = [
			{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" },
			{ id: "a2", src: "file:///tmp/a2.mp4", label: "a2" },
		];
		const onVideoElement = vi.fn();
		const { container, rerender } = render(
			<VirtualPreview
				videoSources={sources}
				clips={clips}
				onTimeChange={vi.fn()}
				onVideoElement={onVideoElement}
			/>,
		);
		const first = container.querySelector("video") as HTMLVideoElement;
		driveVideo(first);
		act(() => fireEvent.loadedMetadata(first));
		expect(onVideoElement).toHaveBeenLastCalledWith(first);
		rerender(
			<VirtualPreview
				videoSources={sources}
				clips={clips}
				seekTarget={{ timeSec: 13, requestId: 1 }}
				onTimeChange={vi.fn()}
				onVideoElement={onVideoElement}
			/>,
		);
		const second = container.querySelector("video") as HTMLVideoElement;
		expect(second).not.toBe(first);
		expect(onVideoElement).toHaveBeenLastCalledWith(second);
		expect(second.isConnected).toBe(true);
		expect(first.isConnected).toBe(false);
	});

	it("moves a paused preview without starting playback", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)];
		const sources: VideoSource[] = [
			{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" },
			{ id: "a2", src: "file:///tmp/a2.mp4", label: "a2" },
		];
		const { container, rerender } = render(
			<VirtualPreview videoSources={sources} clips={clips} onTimeChange={vi.fn()} />,
		);
		const first = container.querySelector("video") as HTMLVideoElement;
		driveVideo(first);
		act(() => fireEvent.loadedMetadata(first));
		rerender(
			<VirtualPreview
				videoSources={sources}
				clips={clips}
				seekTarget={{ timeSec: 13, requestId: 1 }}
				onTimeChange={vi.fn()}
			/>,
		);
		const second = container.querySelector("video") as HTMLVideoElement;
		driveVideo(second);
		act(() => fireEvent.loadedMetadata(second));
		expect(second.currentTime).toBe(3);
		expect(second.play).not.toHaveBeenCalled();
	});
});

describe("VirtualPreview prepared clock hand-off", () => {
	it.each([
		false,
		true,
	])("promotes a ready element without loading or seeking at the cut (same asset: %s)", (sameAsset) => {
		const clips = [clip("c1", "a1", 0, 10, 0), clip("c2", sameAsset ? "a1" : "a2", 2, 10, 10)];
		const sources = [
			{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" },
			{ id: "a2", src: "file:///tmp/a2.mp4", label: "a2" },
		];
		const onVideoElement = vi.fn();
		const onLoadedMetadata = vi.fn();
		const onTimeChange = vi.fn();
		const { container } = render(
			<VirtualPreview
				videoSources={sources}
				clips={clips}
				onVideoElement={onVideoElement}
				onLoadedMetadata={onLoadedMetadata}
				onTimeChange={onTimeChange}
			/>,
		);
		const first = container.querySelector("video") as HTMLVideoElement;
		const firstClock = driveVideo(first);
		act(() => fireEvent.loadedMetadata(first));
		firstClock.play();
		firstClock.seekTo(8);
		tick();
		expect(container.querySelectorAll("video")).toHaveLength(1);
		firstClock.seekTo(9.4);
		tick();
		const next = container.querySelectorAll("video")[1];
		expect(next).toBeDefined();
		driveVideo(next);
		act(() => fireEvent.loadedMetadata(next));
		expect(next.currentTime).toBe(2);
		onLoadedMetadata.mockClear();
		expect(next.paused).toBe(true);
		const seek = vi.spyOn(next, "currentTime", "set");
		firstClock.seekTo(9.96);
		tick();
		expect(container.querySelector("video")).toBe(next);
		expect(onVideoElement).toHaveBeenLastCalledWith(next);
		expect(onTimeChange).toHaveBeenLastCalledWith(10);
		expect(next.play).toHaveBeenCalledOnce();
		expect(onLoadedMetadata).toHaveBeenCalledWith(10, sameAsset ? "a1" : "a2", 0, 0);
		expect(seek).not.toHaveBeenCalled();
		expect(first.paused).toBe(true);
		expect(container.querySelectorAll("video")).toHaveLength(1);
	});

	it("does not let a prepared forward fragment override a backward playing seek", () => {
		const clips = [clip("c1", "a1", 0, 10, 0), clip("c2", "a2", 0, 10, 10)];
		const sources = [
			{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" },
			{ id: "a2", src: "file:///tmp/a2.mp4", label: "a2" },
		];
		const onTimeChange = vi.fn();
		const { container, rerender } = render(
			<VirtualPreview videoSources={sources} clips={clips} onTimeChange={onTimeChange} />,
		);
		const first = container.querySelector("video") as HTMLVideoElement;
		const clock = driveVideo(first);
		act(() => fireEvent.loadedMetadata(first));
		clock.play();
		clock.seekTo(9.4);
		tick();
		const next = container.querySelectorAll("video")[1];
		driveVideo(next);
		act(() => fireEvent.loadedMetadata(next));
		rerender(
			<VirtualPreview
				videoSources={sources}
				clips={clips}
				onTimeChange={onTimeChange}
				seekTarget={{ timeSec: 3, requestId: 1 }}
			/>,
		);
		tick();
		expect(container.querySelector("video")).toBe(first);
		expect(first.currentTime).toBe(3);
		expect(first.paused).toBe(false);
		expect(onTimeChange).toHaveBeenLastCalledWith(3);
	});
});

describe("VirtualPreview hand-off event and audio ownership", () => {
	const clips = [clip("c1", "a1", 0, 10, 0), clip("c2", "a2", 2, 10, 10)];
	const sources = [
		{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" },
		{ id: "a2", src: "file:///tmp/a2.mp4", label: "a2" },
	];
	it("detaches the outgoing pause listener before stopping its clock", () => {
		const stopped = vi.fn();
		function Parent() {
			const [video, setVideo] = useState<HTMLVideoElement | null>(null);
			useEffect(() => {
				video?.addEventListener("pause", stopped);
				return () => video?.removeEventListener("pause", stopped);
			}, [video]);
			return <VirtualPreview clips={clips} videoSources={sources} onVideoElement={setVideo} />;
		}
		const { container } = render(<Parent />);
		const first = container.querySelector("video") as HTMLVideoElement;
		const clock = driveVideo(first);
		first.pause = vi.fn(() => first.dispatchEvent(new Event("pause")));
		act(() => fireEvent.loadedMetadata(first));
		clock.play();
		clock.seekTo(9.4);
		tick();
		const next = container.querySelectorAll("video")[1];
		driveVideo(next);
		act(() => fireEvent.loadedMetadata(next));
		clock.seekTo(9.96);
		tick();
		expect(first.pause).toHaveBeenCalledOnce();
		expect(stopped).not.toHaveBeenCalled();
	});

	it.each([
		false,
		true,
	])("prepares Clean Voice with listening level and recovers a prior same-asset failure (%s)", (recoverFailure) => {
		const cleanSources = sources.map((source) => ({ ...source, audioSrc: `${source.src}.m4a` }));
		const previous = usePreviewAudio.getState();
		usePreviewAudio.setState({ volume: 0.35, muted: false });
		const audioClips = recoverFailure ? [clips[0], { ...clips[1], assetId: "a1" }] : clips;
		const { container } = render(<VirtualPreview clips={audioClips} videoSources={cleanSources} />);
		const first = container.querySelector("video") as HTMLVideoElement;
		const clock = driveVideo(first);
		const oldAudio = container.querySelector("audio") as HTMLAudioElement;
		driveAudio(oldAudio);
		act(() => {
			fireEvent.loadedMetadata(first);
			fireEvent.canPlay(oldAudio);
		});
		if (recoverFailure) act(() => fireEvent.error(oldAudio));
		clock.play();
		clock.seekTo(9.4);
		tick();
		const next = container.querySelectorAll("video")[1];
		const audio = container.querySelectorAll("audio")[recoverFailure ? 0 : 1];
		driveVideo(next);
		driveAudio(audio);
		Object.defineProperty(audio, "readyState", { configurable: true, value: 4 });
		act(() => {
			fireEvent.loadedMetadata(next);
			fireEvent.loadedMetadata(audio);
		});
		expect(audio.currentTime).toBe(2);
		clock.seekTo(9.96);
		tick();
		expect(container.querySelector("audio")).toBe(audio);
		expect(next.muted).toBe(true);
		expect(audio.volume).toBe(0.35);
		expect(audio.muted).toBe(false);
		expect(audio.play).toHaveBeenCalledOnce();
		if (!recoverFailure) expect(oldAudio.pause).toHaveBeenCalled();
		usePreviewAudio.setState(previous);
	});

	it("shares one audio output across StrictMode effects and closes it on unmount", async () => {
		const disconnect = vi.fn();
		const close = vi.fn(() => Promise.resolve());
		const connect = vi.fn();
		const createMediaElementSource = vi.fn(() => ({ connect, disconnect }));
		const contexts = vi.fn();
		class TestAudioContext {
			destination = {};
			createMediaElementSource = createMediaElementSource;
			close = close;
			constructor() {
				contexts();
			}
		}
		vi.stubGlobal("AudioContext", TestAudioContext);
		const { container, unmount } = render(
			<StrictMode>
				<VirtualPreview clips={clips} videoSources={sources} />
			</StrictMode>,
		);
		const first = container.querySelector("video") as HTMLVideoElement;
		driveVideo(first);
		await act(async () => {
			await Promise.resolve();
		});
		expect(contexts).toHaveBeenCalledOnce();
		expect(createMediaElementSource).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
		unmount();
		await act(async () => {
			await Promise.resolve();
		});
		expect(disconnect).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});
});

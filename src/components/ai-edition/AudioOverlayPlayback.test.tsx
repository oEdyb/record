// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	createPlaybackClockRef,
	IDLE_PLAYBACK_LOOP_MS,
	publishPlaybackClock,
} from "@/lib/ai-edition/timeline/playback-clock";
import { AudioOverlayPlayback } from "./AudioOverlayPlayback";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/native/client", () => ({ requireNativeBridgeData: request }));
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
const clock = createPlaybackClockRef();
function fixture() {
	const doc = createEmptyDocument({ projectId: "audio_preview", title: "Preview" });
	doc.assets = [
		{
			id: "video",
			kind: "video",
			label: "Video",
			originalPath: "/tmp/video.mp4",
			cameraTrack: null,
			durationSec: 10,
		},
	];
	doc.timeline.clips = [
		{
			id: "clip",
			assetId: "video",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "test",
		},
	];
	doc.audioAssets = [
		{ id: "music", label: "Music", originalPath: "/tmp/music.wav", durationSec: 10 },
	];
	doc.timeline.audioClips = [
		{
			id: "music_clip",
			assetId: "music",
			startSec: 0,
			endSec: 10,
			sourceOffsetSec: 0,
			gain: 1,
			fadeInSec: 0,
			fadeOutSec: 0,
		},
	];
	return doc;
}
beforeEach(() => {
	frames = new Map();
	request.mockReset();
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
		frames.set(++frameId, fn);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
		/* jsdom has no audio device. */
	});
	useProjectStore.setState({
		document: fixture(),
		projectId: "audio_preview",
		playing: false,
		currentTimeSec: 0,
		transactionBusy: false,
		transactionSyncPending: false,
	});
	clock.current = { virtualTimeSec: 0, sourceTimeSec: 0, isPlaying: false, playbackRate: 1 };
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function ready() {
	request.mockResolvedValue({ sourceUrl: "file:///stem.wav" });
	const mounted = render(<AudioOverlayPlayback clockRef={clock} />);
	await act(async () => {
		/* Flush the pending media promise. */
	});
	const audio = mounted.container.querySelector("audio")!;
	Object.defineProperties(audio, {
		readyState: { value: 4, configurable: true },
		duration: { value: 10, configurable: true },
	});
	fireEvent.canPlay(audio);
	return { audio, ...mounted };
}
function tick() {
	act(() => {
		const current = [...frames.values()];
		frames.clear();
		current.forEach((fn) => fn(0));
	});
}
it("blocks video until the requested stem and media element are ready, and after a load error", async () => {
	let resolve!: (value: { sourceUrl: string }) => void;
	request.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const mounted = render(<AudioOverlayPlayback clockRef={clock} />);
	act(() => useProjectStore.getState().setPlaying(true));
	expect(useProjectStore.getState().playing).toBe(false);
	await act(async () => resolve({ sourceUrl: "file:///stem.wav" }));
	act(() => useProjectStore.getState().setPlaying(true));
	expect(useProjectStore.getState().playing).toBe(false);
	const audio = mounted.container.querySelector("audio")!;
	fireEvent.canPlay(audio);
	act(() => useProjectStore.getState().setPlaying(true));
	expect(useProjectStore.getState().playing).toBe(true);
	fireEvent.waiting(audio);
	act(() => useProjectStore.getState().setPlaying(true));
	expect(useProjectStore.getState().playing).toBe(false);
	fireEvent.canPlay(audio);
	fireEvent.error(audio);
	act(() => useProjectStore.getState().setPlaying(true));
	expect(useProjectStore.getState().playing).toBe(false);
});
it("seeks while paused, follows the raw playback clock at 1x, and pauses on unmount", async () => {
	const { audio, unmount } = await ready();
	act(() => useProjectStore.setState({ currentTimeSec: 4 }));
	tick();
	expect(audio.currentTime).toBe(4);
	act(() => {
		useProjectStore.getState().setPlaying(true);
		clock.current = { virtualTimeSec: 7, sourceTimeSec: 7, isPlaying: true, playbackRate: 2 };
	});
	tick();
	expect(audio.currentTime).toBe(7);
	expect(audio.playbackRate).toBe(1);
	expect(play).toHaveBeenCalledOnce();
	unmount();
	expect(pause).toHaveBeenCalled();
	expect(frames.size).toBe(0);
});
it("discards obsolete stem responses", async () => {
	const responses: Array<(value: { sourceUrl: string }) => void> = [];
	request.mockImplementation(() => new Promise((done) => responses.push(done)));
	const mounted = render(<AudioOverlayPlayback clockRef={clock} />);
	act(() => {
		const doc = fixture();
		doc.timeline.audioClips![0].gain = 0.5;
		useProjectStore.setState({ document: doc });
	});
	await act(async () => responses[1]({ sourceUrl: "file:///new.wav" }));
	await act(async () => responses[0]({ sourceUrl: "file:///old.wav" }));
	expect(mounted.container.querySelector("audio")).toHaveAttribute("src", "file:///new.wav");
});
it("latches a real play failure, but ignores AbortError after an ordinary pause", async () => {
	await ready();
	let reject!: (reason: Error) => void;
	play.mockImplementation(
		() =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
	);
	act(() => {
		useProjectStore.getState().setPlaying(true);
		clock.current.isPlaying = true;
	});
	tick();
	act(() => {
		useProjectStore.getState().setPlaying(false);
		clock.current.isPlaying = false;
	});
	tick();
	await act(async () => reject(new DOMException("paused", "AbortError")));
	expect(screen.queryByText(/playback failed/)).not.toBeInTheDocument();
	play.mockRejectedValue(new Error("decoder failed"));
	act(() => {
		useProjectStore.getState().setPlaying(true);
		clock.current.isPlaying = true;
	});
	tick();
	await act(async () => {
		/* Flush the pending media promise. */
	});
	expect(screen.getByRole("status")).toHaveTextContent("decoder failed");
	act(() => useProjectStore.getState().setPlaying(true));
	expect(useProjectStore.getState().playing).toBe(false);
});

it("pauses again if a pending play resolves after unmount", async () => {
	const { unmount } = await ready();
	let resolve!: () => void;
	play.mockImplementation(
		() =>
			new Promise<void>((done) => {
				resolve = done;
			}),
	);
	act(() => {
		useProjectStore.getState().setPlaying(true);
		clock.current.isPlaying = true;
	});
	tick();
	unmount();
	pause.mockClear();
	await act(async () => resolve());
	expect(pause).toHaveBeenCalled();
	expect(frames.size).toBe(0);
});

it("backs off while paused and wakes immediately for a seek or playback", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const { audio } = await ready();
		for (let index = 0; index < 30; index += 1) tick();
		expect(frames.size).toBe(0);
		vi.advanceTimersByTime(IDLE_PLAYBACK_LOOP_MS - 1);
		expect(frames.size).toBe(0);
		vi.advanceTimersByTime(1);
		tick();
		expect(frames.size).toBe(0);

		act(() => useProjectStore.setState({ currentTimeSec: 4 }));
		expect(frames.size).toBe(1);
		tick();
		expect(audio.currentTime).toBe(4);

		for (let index = 0; index < 30; index += 1) tick();
		act(() => {
			useProjectStore.getState().setPlaying(true);
			publishPlaybackClock(clock, {
				virtualTimeSec: 7,
				sourceTimeSec: 7,
				isPlaying: true,
				playbackRate: 1,
			});
		});
		expect(frames.size).toBe(1);
		tick();
		expect(play).toHaveBeenCalledOnce();
	} finally {
		vi.useRealTimers();
	}
});

// @vitest-environment jsdom

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPreviewAudio } from "@/lib/ai-edition/preview/previewAudio";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";
import { HudClipPeek, type HudClipPeekLabels } from "./HudClipPeek";

vi.mock("@/lib/ai-edition/store/editingPreferences", () => ({
	loadEditingPreferences: () => ({ editor: { webcamLayoutPreset: "default" } }),
}));
vi.mock("@/lib/ai-edition/preview/previewAudio", () => ({
	applyPreviewAudio: vi.fn(),
	usePreviewAudio: (
		select: (state: {
			volume: number;
			muted: boolean;
			setVolume: () => void;
			toggleMuted: () => void;
		}) => unknown,
	) => select({ volume: 1, muted: false, setVolume: vi.fn(), toggleMuted: vi.fn() }),
}));

const labels: HudClipPeekLabels = {
	title: "Replay",
	clipOf: (current, total) => `${current} of ${total}`,
	play: "Play",
	pause: "Pause",
	mute: "Mute",
	unmute: "Unmute",
	volume: "Volume",
	seek: "Seek",
	playbackError: "Clip could not play",
	retry: "Retry clip",
};
const clips = [
	{ index: 0, screenVideoPath: "/first.mp4", durationMs: 8_000 },
	{ index: 1, screenVideoPath: "/removed.mp4", durationMs: 4_000, removed: true },
	{
		index: 2,
		screenVideoPath: "/selected.mp4",
		webcamVideoPath: "/camera.mp4",
		durationMs: 10_000,
	},
];
const onClose = vi.fn();

function replay(open = true) {
	return <HudClipPeek clips={clips} labels={labels} open={open} onClose={onClose} />;
}
function video() {
	const element = screen.getByTestId("hud-clip-peek-video");
	if (!(element instanceof HTMLVideoElement)) throw new Error("Missing replay video");
	return element;
}

beforeEach(() => {
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("replay playback recovery", () => {
	it("reapplies the listening preferences to the replacement media element", async () => {
		render(replay());
		const original = video();
		fireEvent.error(original);
		await screen.findByRole("alert");
		vi.mocked(applyPreviewAudio).mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Retry clip" }));
		const replacement = video();
		expect(replacement).not.toBe(original);
		expect(applyPreviewAudio).toHaveBeenCalledWith(replacement, { volume: 1, muted: false });
	});

	it("announces rejected playback and retries the selected kept clip at its position", async () => {
		vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
			new DOMException("Blocked", "NotAllowedError"),
		);
		render(replay());
		await screen.findByRole("alert");
		expect(screen.getByRole("alert")).toHaveTextContent(labels.playbackError ?? "");
		expect(screen.getByTestId("hud-clip-peek-play")).toHaveAccessibleName("Play");
		expect(screen.getByTestId("hud-clip-peek-play")).toBeDisabled();
		const selectedSource = video().getAttribute("src");
		const previousAttempts = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
		expect(selectedSource).toBe(toKlipptMediaUrl("/selected.mp4"));
		fireEvent.click(screen.getByRole("button", { name: "Retry clip" }));
		fireEvent.loadedMetadata(video());
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
		expect(video().getAttribute("src")).toBe(`${selectedSource}?replayRetry=1`);
		expect(video().currentTime).toBe(5);
		expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBeGreaterThan(
			previousAttempts,
		);
		expect(vi.mocked(HTMLMediaElement.prototype.play).mock.contexts).toContain(video());
		expect(onClose).not.toHaveBeenCalled();
	});

	it.each([
		"hud-clip-peek-video",
		"hud-clip-peek-camera",
	])("offers retry after %s fails", async (testId) => {
		render(replay());
		fireEvent.error(screen.getByTestId(testId));
		expect(await screen.findByRole("alert")).toBeVisible();
		expect(screen.getByTestId("hud-clip-peek-play")).toHaveAccessibleName("Play");
		fireEvent.click(screen.getByRole("button", { name: "Retry clip" }));
		fireEvent.loadedMetadata(video());
		expect(video().currentTime).toBe(5);
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	});

	it("keeps a failed retry in the error state", async () => {
		vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error("Decode failed"));
		render(replay());
		await screen.findByRole("alert");
		fireEvent.click(screen.getByRole("button", { name: "Retry clip" }));
		await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
		expect(screen.getByTestId("hud-clip-peek-play")).toHaveAccessibleName("Play");
	});

	it("ignores a previous play rejection after replay closes", async () => {
		let rejectPlay: (reason: Error) => void = () => undefined;
		vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPlay = reject;
				}),
		);
		const view = render(replay());
		await waitFor(() => expect(video().play).toHaveBeenCalled());
		view.rerender(replay(false));
		await act(async () => rejectPlay(new Error("Old failure")));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

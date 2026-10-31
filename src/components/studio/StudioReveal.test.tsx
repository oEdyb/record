// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioCamera } from "./StudioCamera";
import { StudioReplay } from "./StudioReplay";

let cameraReady = false;
vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("./useStudioLiveCamera", () => ({ useStudioLiveCamera: () => cameraReady }));
afterEach(cleanup);
beforeEach(() => {
	cameraReady = false;
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
it("keeps camera and Live badge concealed until a frame arrives", () => {
	const { container, rerender } = render(<StudioCamera active guides={false} />);
	expect(container.firstChild).toHaveAttribute("data-ready", "false");
	expect(container.querySelector("span")).not.toBeVisible();
	cameraReady = true;
	rerender(<StudioCamera active guides={false} />);
	expect(container.firstChild).toHaveAttribute("data-ready", "true");
	expect(container.querySelector("span")).toBeVisible();
});
it("reveals the replay stage only after screen data, and resets on a new load", () => {
	const { container } = render(
		<StudioReplay
			clips={[
				{
					index: 0,
					screenVideoPath: "/take.mp4",
					webcamVideoPath: "/camera.mp4",
					durationMs: 8000,
				},
			]}
			labels={{
				clipOf: () => "1",
				play: "Play",
				pause: "Pause",
				mute: "Mute",
				unmute: "Unmute",
				seek: "Seek",
				playbackError: "Error",
				recorded: "Recorded",
			}}
			seekRequest={null}
			hold={false}
			shown
			onPosition={() => undefined}
		/>,
	);
	const video = container.querySelector("video");
	if (!video) throw new Error("Missing screen video");
	const stage = video.parentElement;
	expect(stage).toHaveAttribute("data-ready", "false");
	fireEvent.loadedMetadata(video);
	expect(stage).toHaveAttribute("data-ready", "false");
	fireEvent.loadedData(video);
	expect(stage).toHaveAttribute("data-ready", "true");
	fireEvent.loadStart(video);
	expect(stage).toHaveAttribute("data-ready", "false");
});

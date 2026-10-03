// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TimelinePlaybackProjectionSegment } from "@/lib/ai-edition/timeline/timelineMap";
import { CaptionTrack } from "./CaptionTrack";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
const projection = [
	{ rawStartSec: 5, rawEndSec: 15, playbackStartSec: 0, playbackEndSec: 10 },
] as TimelinePlaybackProjectionSegment[];
it("clips captions to kept time, hides removed and offscreen cues, and seeks retained speech", () => {
	const select = vi.fn();
	const { container } = render(
		<CaptionTrack
			cues={[
				{ id: "cut", startMs: 0, endMs: 3000, text: "removed" },
				{ id: "kept", startMs: 4000, endMs: 7000, text: "retained speech" },
				{ id: "later", startMs: 12000, endMs: 14000, text: "offscreen" },
			]}
			projection={projection}
			total={10}
			start={0}
			end={5}
			onSelect={select}
		/>,
	);
	expect(container.querySelector("details")).toBeNull();
	expect(screen.getAllByRole("group")).toHaveLength(1);
	expect(screen.queryByRole("button", { name: "removed" })).toBeNull();
	expect(screen.queryByRole("button", { name: "offscreen" })).toBeNull();
	const cue = screen.getByRole("button", { name: "retained speech" });
	expect(cue).toHaveStyle({ left: "0%", width: "20%" });
	fireEvent.click(cue);
	expect(select).toHaveBeenCalledWith(5);
	expect(cue).toHaveAttribute("aria-pressed", "true");
});
it("does not show an empty caption track", () => {
	const { container } = render(
		<CaptionTrack
			cues={[]}
			projection={projection}
			total={10}
			start={0}
			end={10}
			onSelect={vi.fn()}
		/>,
	);
	expect(container).toBeEmptyDOMElement();
});

// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import type { CleanCutWord } from "@/lib/cleanCut/types";
import { CleanCutTranscript } from "./CleanCutTranscript";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
afterEach(cleanup);

const clip: AxcutClip = {
	id: "c1",
	assetId: "a",
	sourceStartSec: 0,
	sourceEndSec: 10,
	timelineStartSec: 0,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "system",
	reason: "",
};

const words: CleanCutWord[] = ["Hi", "there.", "And", "then", "more."].map((text, i) => ({
	text,
	assetId: "a",
	startSec: i,
	endSec: i + 0.5,
	regionId: null,
}));

it("offers Cut for the hovered sentence, keeps it over gaps, and cuts that sentence", () => {
	const onCutSentence = vi.fn();
	render(
		<CleanCutTranscript
			words={words}
			regions={[]}
			clips={[clip]}
			cutIds={new Set()}
			restoredIds={new Set()}
			selectedId={null}
			query=""
			label="Transcript"
			toPlaybackSec={(sec) => sec}
			onSelectRegion={vi.fn()}
			onSeekRaw={vi.fn()}
			onToggleRestore={vi.fn()}
			onCutSentence={onCutSentence}
		/>,
	);
	fireEvent.pointerOver(screen.getByText("then"));
	expect(screen.getByText("then")).toHaveAttribute("data-sentence");
	expect(screen.getByText("Hi")).not.toHaveAttribute("data-sentence");
	fireEvent.pointerOver(screen.getByRole("document"));
	fireEvent.click(screen.getByRole("button", { name: "cleanCut.cutSentence" }));
	expect(onCutSentence).toHaveBeenCalledWith(2, 4);
});
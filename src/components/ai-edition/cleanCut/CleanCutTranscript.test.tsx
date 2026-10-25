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

function renderTranscript(overrides: Partial<Parameters<typeof CleanCutTranscript>[0]> = {}) {
	const props = {
		words,
		regions: [],
		clips: [clip],
		cutIds: new Set<string>(),
		restoredIds: new Set<string>(),
		selectedId: null,
		sentence: null,
		query: "",
		label: "Transcript",
		toPlaybackSec: (sec: number) => sec,
		onSelectRegion: vi.fn(),
		onSeekRaw: vi.fn(),
		onPickSentence: vi.fn(),
		...overrides,
	};
	render(<CleanCutTranscript {...props} />);
	return props;
}

it("plays kept words from where they are clicked and picks their sentence", () => {
	const props = renderTranscript();
	fireEvent.click(screen.getByText("then"));
	expect(props.onSeekRaw).toHaveBeenCalledWith(3);
	expect(props.onPickSentence).toHaveBeenCalledWith(2, 4);
});

it("marks the picked sentence", () => {
	renderTranscript({ sentence: [2, 4] });
	expect(screen.getByText("then")).toHaveAttribute("data-sentence");
	expect(screen.getByText("Hi")).not.toHaveAttribute("data-sentence");
});

it("strikes a cut and picks it on a click instead of picking a sentence", () => {
	const cutWords = words.map((word, i) => (i < 2 ? { ...word, regionId: "a:0" } : word));
	const props = renderTranscript({ words: cutWords, cutIds: new Set(["a:0"]) });
	const cut = screen.getByText("Hi there.");
	expect(cut).toHaveAttribute("data-state", "cut");
	fireEvent.click(cut);
	expect(props.onSelectRegion).toHaveBeenCalledWith("a:0");
	expect(props.onPickSentence).not.toHaveBeenCalled();
});

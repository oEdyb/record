// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { CleanCutRows } from "./CleanCutRows";
import type { CleanCutGuide } from "./useCleanCutGuide";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

const cut = (id: string, at: number, risky: boolean): ReviewCut => ({
	region: {
		id,
		kind: "retake",
		assetId: "a",
		removedStartSec: at,
		removedEndSec: at + 2,
		words: [`words of ${id}`],
		reason: `why ${id}`,
		sources: ["rule"],
		risky,
	},
	rawStartSec: at,
	rawEndSec: at + 2,
	removedSec: 2,
	restored: false,
});

const guide = () =>
	({
		listen: "without",
		looping: false,
		setListen: vi.fn(),
		replay: vi.fn(),
		toggleLoop: vi.fn(),
	}) as unknown as CleanCutGuide;

it("opens only the picked cut, with why it was cut and its controls", () => {
	const onSelect = vi.fn();
	const cuts = [cut("a", 10, true), cut("b", 30, false)];
	render(
		<CleanCutRows
			cuts={cuts}
			selectedId="a"
			guide={guide()}
			spoken={new Map()}
			onSelect={onSelect}
		/>,
	);
	expect(screen.getByText(/^why a/)).toBeInTheDocument();
	expect(screen.queryByText(/^why b/)).toBeNull();
	expect(screen.getAllByRole("button", { name: "cleanCut.restore" })).toHaveLength(1);
	fireEvent.click(screen.getByText("words of b"));
	expect(onSelect).toHaveBeenCalledWith(cuts[1]);
});

it("replays the picked cut on a second click and keeps it with its button", () => {
	const g = guide();
	const toggleRestore = vi.spyOn(useCleanCutStore.getState(), "toggleRestore");
	render(
		<CleanCutRows
			cuts={[cut("a", 10, true)]}
			selectedId="a"
			guide={g}
			spoken={new Map()}
			onSelect={vi.fn()}
		/>,
	);
	fireEvent.click(screen.getByText("words of a"));
	expect(g.replay).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByRole("button", { name: "cleanCut.restore" }));
	expect(toggleRestore).toHaveBeenCalledWith("a");
});

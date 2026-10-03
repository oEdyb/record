// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { editFixture } from "@/lib/ai-edition/checks/fixtures";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	resetPauseAnalysisStoreForTests,
	usePauseAnalysisStore,
} from "../pauses/pauseAnalysisStore";
import { resetRejectedCutsForTests } from "../pauses/rejectedCuts";
import { ProposedCutPill } from "./ProposedCutPill";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, values?: Record<string, string>) =>
		key === "labels.cutDetails" && values
			? `${values.origin} · ${values.start}–${values.end} s · ${values.saved} s saved`
			: key,
}));
function Harness({ widthPx = 120 }: { widthPx?: number }) {
	const cut = usePauseAnalysisStore((state) => state.suggestions[0]);
	return cut ? (
		<TooltipProvider delayDuration={0}>
			<ProposedCutPill
				cut={cut}
				style={{ width: widthPx }}
				widthPx={widthPx}
				sourceAtOffset={(edge, offset) =>
					(edge === "start" ? cut.sourceStartSec : cut.sourceEndSec) + offset / 100
				}
			/>
		</TooltipProvider>
	) : null;
}
beforeEach(() => {
	resetPauseAnalysisStoreForTests();
	resetRejectedCutsForTests();
	localStorage.clear();
	useProjectStore.setState({ projectId: "project", revision: 1, document: editFixture() });
	usePauseAnalysisStore.getState().stageCuts([
		{
			id: "cut",
			clipId: "clip",
			assetId: "asset",
			sourceStartSec: 2,
			sourceEndSec: 4,
			kind: "agent",
			origin: "agent plan test",
			selected: true,
		},
	]);
	Object.assign(HTMLElement.prototype, {
		setPointerCapture: vi.fn(),
		hasPointerCapture: () => true,
		releasePointerCapture: vi.fn(),
	});
});
it("pointer-drags both handles against the store and reports source delta", () => {
	render(<Harness />);
	const start = screen.getByRole("button", { name: "labels.cutStart" });
	fireEvent.pointerDown(start, { pointerId: 1, button: 0, clientX: 100 });
	fireEvent.pointerMove(start, { pointerId: 1, clientX: 150 });
	expect(usePauseAnalysisStore.getState().suggestions[0].sourceStartSec).toBe(2.5);
	expect(screen.getByText("+0.50 s")).toBeVisible();
	fireEvent.pointerMove(start, { pointerId: 1, clientX: 200 });
	expect(usePauseAnalysisStore.getState().suggestions[0].sourceStartSec).toBe(3);
	fireEvent.pointerUp(start, { pointerId: 1 });
	const end = screen.getByRole("button", { name: "labels.cutEnd" });
	fireEvent.pointerDown(end, { pointerId: 2, button: 0, clientX: 100 });
	fireEvent.pointerMove(end, { pointerId: 2, clientX: 0 });
	expect(usePauseAnalysisStore.getState().suggestions[0].sourceEndSec).toBeCloseTo(3.04);
	fireEvent.pointerCancel(end, { pointerId: 2 });
	fireEvent.pointerMove(end, { pointerId: 2, clientX: 600 });
	expect(usePauseAnalysisStore.getState().suggestions[0].sourceEndSec).toBeCloseTo(3.04);
});
it("toggles on the body and rejects focused pills without triggering document Delete", () => {
	render(<Harness />);
	const body = screen.getByRole("button", { pressed: true });
	fireEvent.click(body);
	expect(usePauseAnalysisStore.getState().suggestions[0].selected).toBe(false);
	const documentDelete = vi.fn();
	window.addEventListener("keydown", documentDelete);
	act(() => body.focus());
	fireEvent.keyDown(body, { key: "Delete" });
	expect(usePauseAnalysisStore.getState().suggestions).toEqual([]);
	expect(documentDelete).not.toHaveBeenCalled();
	window.removeEventListener("keydown", documentDelete);
});

it("shows saved seconds and scissors when there is room, and rejects with ×", () => {
	render(<Harness />);
	expect(screen.getByText("−2.0 s")).toBeVisible();
	expect(screen.getByRole("button", { pressed: true }).querySelector("svg")).not.toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "labels.rejectCut" }));
	expect(usePauseAnalysisStore.getState().suggestions).toEqual([]);
});
it.each([14, 55])("uses an icon without a reject button at %i px", (widthPx) => {
	render(<Harness widthPx={widthPx} />);
	expect(screen.queryByText("−2.0 s")).not.toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "labels.rejectCut" })).not.toBeInTheDocument();
	const body = screen.getByRole("button", { pressed: true });
	expect(body.querySelector("svg")).not.toBeNull();
	fireEvent.keyDown(body, { key: "Backspace" });
	expect(usePauseAnalysisStore.getState().suggestions).toEqual([]);
});
it("shows a compact marker below 14 px and keeps keyboard edge adjustment", () => {
	render(<Harness widthPx={0.3} />);
	expect(screen.getByTestId("proposed-cut-cut")).toHaveAttribute("data-compact", "true");
	expect(screen.getByRole("button", { pressed: true }).querySelector("svg")).toBeNull();
	fireEvent.keyDown(screen.getByRole("button", { name: "labels.cutEnd" }), { key: "ArrowLeft" });
	expect(usePauseAnalysisStore.getState().suggestions[0].sourceEndSec).toBeCloseTo(3.96);
});
it("renders reject at the 56 px boundary and exposes deselection", () => {
	render(<Harness widthPx={56} />);
	expect(screen.getByRole("button", { name: "labels.rejectCut" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { pressed: true }));
	expect(screen.getByTestId("proposed-cut-cut")).toHaveAttribute("data-selected", "false");
});

it("shows origin, source range and saved seconds on focus", async () => {
	render(<Harness />);
	act(() => screen.getByRole("button", { pressed: true }).focus());
	expect(await screen.findByRole("tooltip")).toHaveTextContent(
		"agent plan test · 2.00–4.00 s · 2.00 s saved",
	);
});

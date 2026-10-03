// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	deriveCaptionCues,
	getCaptionSettings,
	patchCaptionSettings,
} from "@/lib/ai-edition/captions";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useCaptionSelectionStore } from "@/lib/ai-edition/store/captionSelectionStore";
import { clearDocumentHistory, takeUndoDocument } from "@/lib/ai-edition/store/documentHistory";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { CaptionCorrection } from "./CaptionCorrection";

const bridgeMocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: { save: bridgeMocks.save } },
}));
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, params?: { number: number }) =>
		params ? `${key} ${params.number}` : key,
}));
afterEach(cleanup);
beforeEach(() => {
	clearDocumentHistory();
	bridgeMocks.save.mockReset();
	bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
	const doc = createEmptyDocument({ projectId: "caption-edit", title: "Caption edit" });
	doc.transcripts = [
		{
			assetId: "source",
			language: "en",
			sources: [],
			evidenceStatus: "legacy-unverified",
			words: [
				{
					id: "w1",
					segmentId: "s1",
					text: "wrong",
					startSec: 0,
					endSec: 1,
					sourceRole: "unknown-mixed",
				},
				{
					id: "w2",
					segmentId: "s1",
					text: "word",
					startSec: 1,
					endSec: 2,
					sourceRole: "unknown-mixed",
				},
			],
			segments: [
				{
					id: "s1",
					text: "wrong word",
					wordIds: ["w1", "w2"],
					startSec: 0,
					endSec: 2,
					kind: "speech",
					sourceRole: "unknown-mixed",
				},
			],
		},
	];
	doc.timeline.clips = [
		{
			id: "c1",
			assetId: "source",
			sourceStartSec: 0,
			sourceEndSec: 2,
			timelineStartSec: 0,
			timelineEndSec: 2,
			wordRefs: [],
			origin: "user",
			reason: "",
		},
	];
	const document = patchCaptionSettings(doc, { enabled: true });
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 0,
		status: "ready",
		transactionBusy: false,
		transactionSyncPending: false,
	});
	select();
});
function select() {
	const document = useProjectStore.getState().document!;
	useCaptionSelectionStore
		.getState()
		.select(document, deriveCaptionCues(document, getCaptionSettings(document), {})[0]);
}
it("saves all corrected words once and supports Undo, reselection and correction again", async () => {
	const original = useProjectStore.getState().document!;
	render(<CaptionCorrection language={null} />);
	fireEvent.change(screen.getByRole("textbox", { name: "captions.correctionWord 1" }), {
		target: { value: "right" },
	});
	fireEvent.change(screen.getByRole("textbox", { name: "captions.correctionWord 2" }), {
		target: { value: "words" },
	});
	expect(bridgeMocks.save).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "captions.saveCorrection" }));
	await waitFor(() =>
		expect(useProjectStore.getState().document?.transcripts[0].segments[0].text).toBe(
			"right words",
		),
	);
	expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	expect(screen.queryByRole("textbox")).toBeNull();
	const undo = takeUndoDocument(useProjectStore.getState().document!)!;
	expect(undo.transcripts).toEqual(original.transcripts);
	expect(takeUndoDocument(undo)).toBeNull();
	act(() => {
		useProjectStore.setState({ document: undo });
		select();
	});
	expect(screen.getByRole("textbox", { name: "captions.correctionWord 1" })).toHaveValue("wrong");
	fireEvent.change(screen.getByRole("textbox", { name: "captions.correctionWord 1" }), {
		target: { value: "correct" },
	});
	fireEvent.click(screen.getByRole("button", { name: "captions.saveCorrection" }));
	await waitFor(() =>
		expect(useProjectStore.getState().document?.transcripts[0].words[0].text).toBe("correct"),
	);
});
it("invalidates a draft after a document change and resets it on reselection", () => {
	render(<CaptionCorrection language={null} />);
	fireEvent.change(screen.getByRole("textbox", { name: "captions.correctionWord 1" }), {
		target: { value: "draft" },
	});
	act(() => {
		const document = useProjectStore.getState().document!;
		useProjectStore.setState({ document: { ...document } });
	});
	expect(screen.queryByRole("textbox")).toBeNull();
	act(select);
	expect(screen.getByRole("textbox", { name: "captions.correctionWord 1" })).toHaveValue("wrong");
	expect(bridgeMocks.save).not.toHaveBeenCalled();
});
it("blocks empty or multiple words and hides the source editor in translated mode", () => {
	const view = render(<CaptionCorrection language={null} />);
	fireEvent.change(screen.getByRole("textbox", { name: "captions.correctionWord 1" }), {
		target: { value: "two words" },
	});
	expect(screen.getByRole("button", { name: "captions.saveCorrection" })).toBeDisabled();
	view.rerender(<CaptionCorrection language="sv" />);
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(screen.getByText("captions.correctionOriginalOnly")).toBeInTheDocument();
});
it("keeps a failed save editable without adding Undo history", async () => {
	bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });
	render(<CaptionCorrection language={null} />);
	fireEvent.change(screen.getByRole("textbox", { name: "captions.correctionWord 1" }), {
		target: { value: "correct" },
	});
	fireEvent.click(screen.getByRole("button", { name: "captions.saveCorrection" }));
	await waitFor(() =>
		expect(screen.getByRole("alert")).toHaveTextContent("captions.correctionSaveFailed"),
	);
	expect(useProjectStore.getState().document?.transcripts[0].words[0].text).toBe("wrong");
	expect(takeUndoDocument(useProjectStore.getState().document!)).toBeNull();
});

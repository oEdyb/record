// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { AutomaticReview } from "./AutomaticReview";

const save = vi.fn(async (_next: AxcutDocument, _base?: AxcutDocument | null) => true);
function fixture(): AxcutDocument {
	const base = createEmptyDocument({ title: "Review", projectId: "review" });
	return {
		...base,
		assets: [
			{
				id: "a",
				kind: "video",
				label: "Screen",
				durationSec: 20,
				originalPath: "/screen.mp4",
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
		zoomRanges: [
			{
				id: "auto",
				startMs: 3000,
				endMs: 6000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				source: "auto",
				directionGroupId: "g",
				automaticDirection: { version: 1, reason: "typing" },
			},
			{
				id: "manual",
				startMs: 10000,
				endMs: 13000,
				depth: 3,
				focus: { cx: 0.4, cy: 0.4 },
				source: "manual",
			},
		],
	};
}
function show(props: Partial<React.ComponentProps<typeof AutomaticReview>> = {}) {
	return render(
		<I18nProvider>
			<AutomaticReview onBeforeChange={() => true} onRegenerate={() => undefined} {...props} />
		</I18nProvider>,
	);
}
beforeEach(() => {
	save.mockReset();
	save.mockResolvedValue(true);
	useProjectStore.setState({
		document: fixture(),
		projectId: "review",
		saveDocumentAsEdit: save,
		playing: false,
	});
});
describe("automatic review", () => {
	it("announces pending persistence and restores focus after the last review row disappears", async () => {
		let complete!: (value: boolean) => void;
		save.mockImplementation(async (next) => {
			const result = await new Promise<boolean>((resolve) => {
				complete = resolve;
			});
			if (result) useProjectStore.setState({ document: next });
			return result;
		});
		show();
		const keep = screen.getByRole("button", { name: "Keep" });
		keep.focus();
		fireEvent.click(keep);
		expect(screen.getByRole("status")).toHaveTextContent("Saving review");
		expect(keep).toBeDisabled();
		await act(async () => complete(true));
		expect(screen.getByRole("status")).toHaveTextContent("Review saved");
		expect(screen.getByRole("status")).toHaveFocus();
	});
	it.each([
		"Keep",
		"Keep all",
	])("restores %s focus when a failed save leaves focus on the body", async (name) => {
		let complete!: (value: boolean) => void;
		save.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					complete = resolve;
				}),
		);
		show();
		const action = screen.getByRole("button", { name });
		action.focus();
		fireEvent.click(action);
		expect(action).toBeDisabled();
		// Chromium can drop focus when the focused button becomes disabled.
		window.document.body.tabIndex = -1;
		window.document.body.focus();
		window.document.body.removeAttribute("tabindex");
		expect(window.document.body).toHaveFocus();
		await act(async () => complete(false));
		expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
		expect(action).toHaveFocus();
	});
	it("does not take focus from another control after a failed save", async () => {
		let complete!: (value: boolean) => void;
		save.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					complete = resolve;
				}),
		);
		show();
		const action = screen.getByRole("button", { name: "Keep" });
		action.focus();
		fireEvent.click(action);
		const elsewhere = window.document.createElement("button");
		window.document.body.append(elsewhere);
		elsewhere.focus();
		await act(async () => complete(false));
		expect(elsewhere).toHaveFocus();
		elsewhere.remove();
	});
	it("clears the saved acknowledgement after Undo or another document edit", async () => {
		const base = useProjectStore.getState().document!;
		save.mockImplementation(async (next) => {
			// Persistence can publish a parsed copy instead of the proposed object.
			useProjectStore.setState({ document: { ...next } });
			return true;
		});
		show();
		fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Review saved"));
		const committed = useProjectStore.getState().document!;
		act(() => useProjectStore.setState({ playing: true }));
		expect(screen.getByRole("status")).toHaveTextContent("Review saved");
		act(() => useProjectStore.setState({ document: base }));
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
		// Returning to a prior saved object must not revive an old receipt.
		act(() => useProjectStore.setState({ document: committed }));
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});
	it("continues keyboard review on the next matching row action", async () => {
		const base = fixture();
		useProjectStore.setState({
			document: {
				...base,
				zoomRanges: [
					...base.zoomRanges,
					{
						...base.zoomRanges[0],
						id: "auto-2",
						directionGroupId: "g-2",
						startMs: 7000,
						endMs: 9000,
					},
				],
			},
		});
		save.mockImplementation(async (next) => {
			useProjectStore.setState({ document: next });
			return true;
		});
		show();
		const first = screen.getAllByRole("button", { name: "Remove" })[0];
		first.focus();
		fireEvent.click(first);
		await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus());
	});
	it("shows stored trigger and seeks to the ordinary timeline region", () => {
		const onSeek = vi.fn();
		const onAdjust = vi.fn();
		show({ onSeek, onAdjust });
		expect(screen.getByText("Typing activity detected")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Go to Screen zoom at 0:03.0" }));
		expect(onSeek).toHaveBeenCalledWith(3);
		fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
		expect(onAdjust).toHaveBeenCalledWith({ kind: "zoom", id: "auto" });
		expect(save).not.toHaveBeenCalled();
	});
	it("removes automatic work in one saved edit while preserving manual work and media", async () => {
		const base = useProjectStore.getState().document!;
		show();
		fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		const next = save.mock.calls[0][0];
		expect(next.zoomRanges).toEqual([base.zoomRanges[1]]);
		expect(next.automaticDirectionDismissals).toHaveLength(1);
		expect(next.assets).toBe(base.assets);
		expect(next.timeline).toBe(base.timeline);
		expect(save.mock.calls[0][1]).toBe(base);
	});
	it("keeps reviewed effects as manual and shows save failure without hiding the effect", async () => {
		save.mockResolvedValue(false);
		show();
		fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save"));
		expect(save.mock.calls[0][0].zoomRanges.every((region) => region.source === "manual")).toBe(
			true,
		);
		expect(screen.getByText("Typing activity detected")).toBeInTheDocument();
	});
	it("does not mutate while regeneration owns the edit or when a project changed", () => {
		const { unmount } = show({ busy: true });
		expect(screen.getByRole("button", { name: "Remove all" })).toBeDisabled();
		unmount();
		show({
			onBeforeChange: () => {
				useProjectStore.setState({
					document: createEmptyDocument({ title: "Other", projectId: "other" }),
				});
				return true;
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
		expect(save).not.toHaveBeenCalled();
	});
});

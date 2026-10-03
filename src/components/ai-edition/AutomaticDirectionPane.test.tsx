// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

const available = vi.hoisted(() => ({ value: true }));
const regenerate = vi.fn(async (..._args: unknown[]) => ({
	screenZooms: 1,
	cameraEmphasis: 0,
	recordings: 1,
}));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("./regenerateAutomaticDirection", () => ({
	canRegenerateAutomaticDirection: () => available.value,
	regenerateProjectAutomaticDirection: (...args: unknown[]) => regenerate(...args),
}));

import { AutomaticDirectionPane } from "./AutomaticDirectionPane";

const presetStorage = (() => {
	const values = new Map<string, string>();
	return {
		clear: () => values.clear(),
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
	};
})();

function recordedProject() {
	const base = createEmptyDocument({
		title: "Direction",
		projectId: "project-1",
	});
	return {
		...base,
		zoomRanges: [
			{
				id: "auto-zoom",
				startMs: 1000,
				endMs: 2000,
				depth: 2 as const,
				focus: { cx: 0.5, cy: 0.5 },
				source: "auto" as const,
			},
		],
		assets: [
			{
				id: "asset-1",
				kind: "video" as const,
				label: "Recording",
				originalPath: "/recordings/clip.mp4",
				recordingImportId: "recording-1",
				durationSec: 10,
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "system" as const,
					reason: "Recorded clip",
				},
			],
		},
	};
}

beforeEach(() => {
	available.value = true;
	vi.useFakeTimers();
	regenerate.mockReset();
	regenerate.mockResolvedValue({
		screenZooms: 1,
		cameraEmphasis: 0,
		recordings: 1,
	});
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: presetStorage,
	});
	window.localStorage.clear();
	useProjectStore.setState({
		projectId: "project-1",
		document: recordedProject(),
		revision: 1,
		status: "ready",
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("AutomaticDirectionPane", () => {
	it("saves tuning without generating until Apply is pressed on a raw recording", async () => {
		const raw = { ...recordedProject(), zoomRanges: [] };
		const patch = vi
			.spyOn(useProjectStore.getState(), "applyDocumentPatch")
			.mockImplementation(async (_id, apply) => {
				useProjectStore.setState((state) => ({
					document: apply(state.document!),
					revision: state.revision + 1,
				}));
				return "applied";
			});
		useProjectStore.setState({ document: raw });
		render(<AutomaticDirectionPane />);
		fireEvent.click(screen.getByText("automaticReview.tune"));
		fireEvent.keyDown(screen.getByRole("slider", { name: "Max Zoom" }), { key: "ArrowLeft" });
		await act(async () => vi.advanceTimersByTimeAsync(180));
		expect(regenerate).not.toHaveBeenCalled();
		expect(patch).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.zoomRanges).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "automaticReview.regenerate" }));
		await act(async () => undefined);
		expect(regenerate).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({ policy: expect.objectContaining({ maximumScreenScale: 1.6 }) }),
		);
		patch.mockRestore();
	});
	it("shows one unavailable state without inactive tuning controls", () => {
		available.value = false;
		useProjectStore.setState({ document: { ...recordedProject(), zoomRanges: [] } });
		render(<AutomaticDirectionPane />);
		expect(screen.getByText("automaticReview.recordingRequired")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "automaticReview.regenerate" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("automaticReview.tune")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("combobox", { name: "Automatic editing preset" }),
		).not.toBeInTheDocument();
	});
	it("cancels queued tuning when switching projects before regeneration", async () => {
		render(<AutomaticDirectionPane />);
		fireEvent.click(screen.getByText("automaticReview.tune"));
		const slider = screen.getByRole("slider", { name: "Max Zoom" });
		fireEvent.keyDown(slider, { key: "ArrowLeft" });
		const other = recordedProject();
		other.project.id = "project-2";
		act(() => useProjectStore.setState({ projectId: "project-2", document: other, revision: 2 }));
		await act(async () => vi.advanceTimersByTimeAsync(180));
		expect(regenerate).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "automaticReview.regenerate" }));
		await act(async () => undefined);
		expect(regenerate).toHaveBeenCalledWith(
			"project-2",
			expect.objectContaining({
				policy: expect.objectContaining({ maximumScreenScale: 1.65 }),
				createHistorySnapshot: true,
			}),
		);
	});
	it("replans from Max Zoom after a short debounce", async () => {
		const { container } = render(<AutomaticDirectionPane />);
		fireEvent.click(screen.getByText("automaticReview.tune"));
		const slider = screen.getByRole("slider", { name: "Max Zoom" });
		slider.focus();
		for (let index = 0; index < 5; index += 1) {
			fireEvent.keyDown(slider, { key: "ArrowLeft" });
		}
		expect(regenerate).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(180);
		});

		expect(regenerate).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({
				policy: expect.objectContaining({ maximumScreenScale: 1.4 }),
				presetId: null,
				createHistorySnapshot: true,
			}),
		);
		expect(container).toHaveTextContent("All parameters");
	});

	it("saves the current policy as a reusable custom preset", () => {
		render(<AutomaticDirectionPane />);
		fireEvent.click(document.querySelector<HTMLButtonElement>('button[title="Save preset"]')!);
		fireEvent.change(screen.getByPlaceholderText("Preset name"), {
			target: { value: "My tutorials" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByRole("combobox", { name: "Automatic editing preset" })).toHaveTextContent(
			"My tutorials",
		);
	});

	it("records one history snapshot for consecutive changes in one tuning session", async () => {
		regenerate.mockImplementation(async () => {
			useProjectStore.setState((state) => ({ revision: state.revision + 1 }));
			return { screenZooms: 1, cameraEmphasis: 0, recordings: 1 };
		});
		render(<AutomaticDirectionPane />);
		fireEvent.click(screen.getByText("automaticReview.tune"));
		const slider = screen.getByRole("slider", { name: "Max Zoom" });
		slider.focus();
		for (let index = 0; index < 7; index += 1) {
			fireEvent.keyDown(slider, { key: "ArrowRight" });
		}
		await act(async () => vi.advanceTimersByTimeAsync(180));
		for (let index = 0; index < 10; index += 1) {
			fireEvent.keyDown(slider, { key: "ArrowRight" });
		}
		await act(async () => vi.advanceTimersByTimeAsync(180));

		expect(regenerate).toHaveBeenNthCalledWith(
			1,
			"project-1",
			expect.objectContaining({ createHistorySnapshot: true }),
		);
		expect(regenerate).toHaveBeenNthCalledWith(
			2,
			"project-1",
			expect.objectContaining({ createHistorySnapshot: false }),
		);
	});
});

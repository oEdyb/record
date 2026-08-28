// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

const regenerate = vi.fn(async (..._args: unknown[]) => ({
	screenZooms: 1,
	cameraEmphasis: 0,
	recordings: 1,
}));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("./regenerateAutomaticDirection", () => ({
	canRegenerateAutomaticDirection: () => true,
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
	it("replans from Max Zoom after a short debounce", async () => {
		const { container } = render(<AutomaticDirectionPane />);
		const maxZoom = screen.getByText("Max Zoom").closest("div")?.parentElement;
		const slider = maxZoom?.querySelector<HTMLInputElement>('input[type="range"]');
		expect(slider).not.toBeNull();
		fireEvent.change(slider!, { target: { value: "1.4" } });
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
		const maxZoom = screen.getByText("Max Zoom").closest("div")?.parentElement;
		const slider = maxZoom?.querySelector<HTMLInputElement>('input[type="range"]');

		fireEvent.change(slider!, { target: { value: "2" } });
		await act(async () => vi.advanceTimersByTimeAsync(180));
		fireEvent.change(slider!, { target: { value: "2.5" } });
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

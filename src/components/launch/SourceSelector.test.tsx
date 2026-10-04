// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceSelector } from "./SourceSelector";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (namespace: string) => {
		if (namespace === "common") {
			return (key: string) => {
				if (key === "actions.cancel") return "Cancel";
				if (key === "actions.share") return "Share";
				if (key === "actions.reload") return "Reload";
				return key;
			};
		}

		return (key: string, vars?: Record<string, string>) => {
			if (key === "sourceSelector.loading") return "Loading sources...";
			if (key === "sourceSelector.emptyTitle") return "No screens or windows found";
			if (key === "sourceSelector.emptyDescription") {
				return "If you just granted screen recording permission, reload this picker. On macOS you may need to reopen OpenScreen.";
			}
			if (key === "sourceSelector.loadFailedDescription") {
				return "OpenScreen could not load capture sources. Reload this picker and try again.";
			}
			if (key === "sourceSelector.screens") return `Screens (${vars?.count ?? "0"})`;
			if (key === "sourceSelector.windows") return `Windows (${vars?.count ?? "0"})`;
			return key;
		};
	},
}));

describe("SourceSelector", () => {
	beforeEach(() => {
		window.electronAPI = {
			...window.electronAPI,
			getSources: vi.fn().mockResolvedValue([]),
			selectSource: vi.fn(),
		} as typeof window.electronAPI;
	});

	it("shows a retry state when no capture sources are available", async () => {
		render(<SourceSelector />);

		await screen.findByText("No screens or windows found");
		expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
	});

	it("reloads capture sources from the empty state", async () => {
		const getSources = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					id: "screen:1:0",
					name: "Display 1",
					thumbnail: "data:image/png;base64,abc",
					display_id: "1",
					appIcon: null,
				},
			]);
		window.electronAPI = {
			...window.electronAPI,
			getSources,
			selectSource: vi.fn(),
		} as typeof window.electronAPI;

		render(<SourceSelector />);

		await screen.findByText("No screens or windows found");
		fireEvent.click(screen.getByRole("button", { name: "Reload" }));

		await waitFor(() => {
			expect(screen.getByText("Display 1")).toBeInTheDocument();
		});
		expect(getSources).toHaveBeenCalledTimes(2);
	});

	it("shows a screen placeholder instead of a broken image when a thumbnail is unavailable", async () => {
		window.electronAPI = {
			...window.electronAPI,
			getSources: vi.fn().mockResolvedValue([
				{
					id: "screen:1:0",
					name: "Entire Screen",
					thumbnail: null,
					display_id: "1",
					appIcon: null,
				},
			]),
			selectSource: vi.fn(),
		} as typeof window.electronAPI;

		render(<SourceSelector />);

		await screen.findByText("Entire Screen");
		expect(screen.getByTestId("source-thumbnail-placeholder")).toBeInTheDocument();
		expect(screen.queryByRole("img", { name: "Entire Screen" })).not.toBeInTheDocument();
	});

	it("chooses a source in one click and switches between screens and windows", async () => {
		const screenSource = {
			id: "screen:1:0",
			name: "Entire Screen",
			thumbnail: null,
			display_id: "1",
			appIcon: null,
		};
		const windowSource = { ...screenSource, id: "window:9:0", name: "Editor" };
		const selectSource = vi.fn().mockResolvedValue(windowSource);
		window.electronAPI = {
			...window.electronAPI,
			getSources: vi.fn().mockResolvedValue([screenSource, windowSource]),
			selectSource,
		} as typeof window.electronAPI;

		render(<SourceSelector />);
		await screen.findByText("Entire Screen");
		expect(screen.queryByText("Editor")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: /Windows \(1\)/ }));
		fireEvent.click(await screen.findByText("Editor"));
		await waitFor(() => expect(selectSource).toHaveBeenCalledWith(windowSource));
		expect(screen.queryByTestId("source-selector-share-button")).not.toBeInTheDocument();
	});

	it("keeps the old choice and says so when switching fails", async () => {
		const toastError = vi.mocked(toast.error);
		window.electronAPI = {
			...window.electronAPI,
			getSources: vi.fn().mockResolvedValue([
				{
					id: "screen:1:0",
					name: "Entire Screen",
					thumbnail: null,
					display_id: "1",
					appIcon: null,
				},
			]),
			selectSource: vi.fn().mockRejectedValue(new Error("save failed")),
		} as typeof window.electronAPI;

		render(<SourceSelector />);
		const card = (await screen.findByText("Entire Screen")).closest("button");
		if (!card) throw new Error("card missing");
		fireEvent.click(card);

		await waitFor(() => expect(toastError).toHaveBeenCalledWith("sourceSelector.selectFailed"));
		expect(card).toHaveAttribute("aria-pressed", "false");
	});
});

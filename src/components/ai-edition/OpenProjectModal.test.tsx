// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { OpenProjectModal } from "./Modals";

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

const projects = [
	{ id: "proj_one", title: "First project", updatedAt: "2026-08-12T10:00:00.000Z" },
	{ id: "proj_two", title: "Second project", updatedAt: "2026-08-13T10:00:00.000Z" },
];

function renderModal(
	overrides: {
		onSelect?: () => void;
		onDelete?: () => void;
		loading?: boolean;
		loadFailed?: boolean;
		recordingOnly?: boolean;
	} = {},
) {
	const onSelect = overrides.onSelect ?? vi.fn();
	const onDelete = overrides.onDelete ?? vi.fn();
	renderWithI18n(
		<OpenProjectModal
			loading={overrides.loading}
			loadFailed={overrides.loadFailed}
			recordingOnly={overrides.recordingOnly}
			open={true}
			onClose={vi.fn()}
			projects={projects}
			activeProjectId={null}
			onSelect={onSelect}
			onDelete={onDelete}
			onBrowse={vi.fn()}
		/>,
	);
	return { onSelect, onDelete };
}

describe("OpenProjectModal delete", () => {
	it("hides stale results while loading or after a failed refresh", () => {
		const first = renderModal({ loading: true });
		expect(screen.getByRole("status")).toHaveTextContent("Loading");
		expect(screen.queryByText("First project")).not.toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
		expect(first.onSelect).not.toHaveBeenCalled();
		cleanup();
		renderModal({ loadFailed: true });
		expect(screen.getByRole("alert")).toHaveTextContent("Failed to load");
		expect(screen.queryByText("First project")).not.toBeInTheDocument();
	});
	it("uses recording language on the capture surface", () => {
		renderModal({ recordingOnly: true });
		expect(screen.getByRole("dialog", { name: "Recordings" })).toBeInTheDocument();
		expect(screen.queryByText(/id: proj/)).not.toBeInTheDocument();
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});
	it("opens the first search match with Enter", () => {
		const { onSelect } = renderModal();
		const search = screen.getByRole("searchbox");
		fireEvent.change(search, { target: { value: "second" } });
		fireEvent.keyDown(search, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith("proj_two");
	});
	it("moves between search and recording rows with arrow keys", () => {
		renderModal();
		const search = screen.getByRole("searchbox");
		search.focus();
		fireEvent.keyDown(search, { key: "ArrowDown" });
		const first = screen.getByRole("button", { name: /First project/ });
		const second = screen.getByRole("button", { name: /Second project/ });
		expect(first).toHaveFocus();
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(second).toHaveFocus();
		fireEvent.keyDown(second, { key: "ArrowDown" });
		expect(search).toHaveFocus();
		fireEvent.keyDown(search, { key: "ArrowUp" });
		expect(second).toHaveFocus();
	});
	it("does not open empty searches, repeated Enter or composition", () => {
		const { onSelect } = renderModal();
		const search = screen.getByRole("searchbox");
		fireEvent.keyDown(search, { key: "Enter", repeat: true });
		fireEvent.keyDown(search, { key: "Enter", isComposing: true });
		fireEvent.change(search, { target: { value: "missing" } });
		fireEvent.keyDown(search, { key: "Enter" });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("asks before deleting instead of deleting on the first click", () => {
		const { onDelete } = renderModal();

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);

		expect(onDelete).not.toHaveBeenCalled();
		expect(screen.getByText(/recordings are kept/i)).toBeInTheDocument();
	});

	it("deletes the project the confirm was armed on", () => {
		const { onDelete } = renderModal();

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[1]);
		fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

		expect(onDelete).toHaveBeenCalledWith("proj_two");
	});

	it("cancels back to the row", () => {
		const { onDelete } = renderModal();

		fireEvent.click(screen.getAllByRole("button", { name: /delete project/i })[0]);
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		expect(onDelete).not.toHaveBeenCalled();
		expect(screen.getByText("First project")).toBeInTheDocument();
		expect(screen.queryByText(/recordings are kept/i)).not.toBeInTheDocument();
	});

	// The delete button sits next to the row's own button, not inside it — a
	// nested button would swallow the click that opens the project.
	it("still opens a project when the row is clicked", () => {
		const { onSelect } = renderModal();

		fireEvent.click(screen.getByText("First project"));

		expect(onSelect).toHaveBeenCalledWith("proj_one");
	});
});

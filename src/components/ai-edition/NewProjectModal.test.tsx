// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { NewProjectModal } from "./Modals";

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("NewProjectModal starting points", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("offers only the two wired starting points", () => {
		renderWithI18n(<NewProjectModal open={true} onClose={vi.fn()} onCreate={vi.fn()} />);

		expect(screen.getByText(/import media/i)).toBeInTheDocument();
		expect(screen.getByText(/screen recording/i)).toBeInTheDocument();
		expect(screen.queryByText(/blank project/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/from template/i)).not.toBeInTheDocument();
	});

	it("creates with the import starting point by default", () => {
		const onCreate = vi.fn();
		renderWithI18n(<NewProjectModal open={true} onClose={vi.fn()} onCreate={onCreate} />);

		fireEvent.click(screen.getByRole("button", { name: /create project/i }));

		expect(onCreate).toHaveBeenCalledWith("Untitled project", "import");
	});

	it("creates with the screen-recording starting point once that cell is picked", () => {
		const onCreate = vi.fn();
		renderWithI18n(<NewProjectModal open={true} onClose={vi.fn()} onCreate={onCreate} />);

		fireEvent.click(screen.getByText(/screen recording/i));
		fireEvent.click(screen.getByRole("button", { name: /create project/i }));

		expect(onCreate).toHaveBeenCalledWith("Untitled project", "screen-recording");
	});

	it("contains keyboard focus and restores it when the dialog closes", async () => {
		const user = userEvent.setup();
		const trigger = document.createElement("button");
		document.body.append(trigger);
		trigger.focus();
		const onClose = vi.fn();
		const view = renderWithI18n(
			<NewProjectModal open={true} onClose={onClose} onCreate={vi.fn()} />,
		);

		expect(screen.getByRole("textbox", { name: /name/i })).toHaveFocus();
		const create = screen.getByRole("button", { name: /create project/i });
		create.focus();
		await user.tab();
		expect(screen.getByRole("button", { name: /close/i })).toHaveFocus();

		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
		view.rerender(
			<I18nProvider>
				<NewProjectModal open={false} onClose={onClose} onCreate={vi.fn()} />
			</I18nProvider>,
		);
		await waitFor(() => expect(trigger).toHaveFocus());
		trigger.remove();
	});
});

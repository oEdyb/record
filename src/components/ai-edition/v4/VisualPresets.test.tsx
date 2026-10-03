// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { loadVisualPresets } from "@/lib/ai-edition/store/visualPresets";
import { VisualPresets } from "./VisualPresets";

const save = vi.fn();
beforeEach(() => {
	localStorage.clear();
	save.mockReset().mockResolvedValue(true);
	useProjectStore.setState({
		document: createEmptyDocument({ projectId: "preset-test", title: "Preset" }),
		saveDocumentAsEdit: save,
	});
});
afterEach(cleanup);
it("applies one saved document edit and closes the picker", async () => {
	render(
		<I18nProvider>
			<VisualPresets readOnly={false} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Presets" }));
	fireEvent.click(screen.getByRole("button", { name: "Clean" }));
	await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
	await waitFor(() =>
		expect(screen.queryByRole("button", { name: "Clean" })).not.toBeInTheDocument(),
	);
});
it("saves a reusable look without editing the document", () => {
	render(
		<I18nProvider>
			<VisualPresets readOnly={false} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Presets" }));
	fireEvent.change(screen.getByLabelText("Save current style"), {
		target: { value: "My tutorial" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
	expect(loadVisualPresets()[0].name).toBe("My tutorial");
	expect(save).not.toHaveBeenCalled();
});
it("keeps failure visible and does not report an applied style", async () => {
	save.mockResolvedValue(false);
	render(
		<I18nProvider>
			<VisualPresets readOnly={false} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Presets" }));
	fireEvent.click(screen.getByRole("button", { name: "Clean" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Could not apply");
});
it("does not expose mutations for a read-only project", () => {
	render(
		<I18nProvider>
			<VisualPresets readOnly />
		</I18nProvider>,
	);
	expect(screen.getByRole("button", { name: "Presets" })).toBeDisabled();
});

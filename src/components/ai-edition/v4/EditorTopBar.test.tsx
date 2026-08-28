// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ProjectNameField is a private helper inside EditorTopBar, so reach it through
// the public topbar instead. The translator echoes keys; assertions read better
// against keys than against prose that drifts with copy edits.
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: () => undefined }),
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/hooks/useTheme", () => ({
	useTheme: () => ({ theme: "dark", toggle: () => undefined }),
}));

import { EditorTopBar } from "./EditorTopBar";

const noop = () => undefined;

function renderTopBar(
	projectTitle: string | null,
	options: { readOnly?: boolean; entitlementLabel?: string | null } = {},
) {
	const onRename = vi.fn();
	const onRecord = vi.fn();
	const onRegenerate = vi.fn();
	const onImportMedia = vi.fn();
	const onEntitlement = vi.fn();
	render(
		<EditorTopBar
			mode="edit"
			onModeChange={noop}
			projectTitle={projectTitle}
			dirty={false}
			canExport={false}
			canImportMedia={projectTitle != null}
			canRegenerateAutomaticEdits={projectTitle != null}
			regeneratingAutomaticEdits={false}
			importingMedia={false}
			chatOpen={false}
			readOnly={options.readOnly ?? false}
			entitlementLabel={options.entitlementLabel ?? null}
			onEntitlement={onEntitlement}
			actions={{
				openProject: noop,
				newProject: noop,
				importMedia: onImportMedia,
				save: noop,
				export: noop,
				openSettings: noop,
				renameProject: onRename,
				toggleChat: noop,
				record: onRecord,
				regenerateAutomaticEdits: onRegenerate,
			}}
		/>,
	);
	return { onRename, onRecord, onRegenerate, onImportMedia, onEntitlement };
}

describe("editor workspace navigation", () => {
	it("uses the canonical mark without a redundant product wordmark", () => {
		renderTopBar("Demo Project");
		const topbar = screen.getByRole("banner");

		expect(topbar).not.toHaveTextContent("Klippt");
		const mark = topbar.querySelector('[data-klippt-mark="canonical"]');
		expect(mark).toBeInTheDocument();
		expect(mark?.querySelector("svg")).toBeInTheDocument();
	});

	it("shows read-only access without letting the project name enter edit mode", () => {
		const { onEntitlement, onRename } = renderTopBar("Demo Project", {
			readOnly: true,
			entitlementLabel: "Read only",
		});

		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		expect(onEntitlement).toHaveBeenCalledOnce();
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /Read only/ })).toBeInTheDocument();
	});

	it("shows recording as the one workspace action while the inherited Media workspace is hidden", () => {
		const { onRecord } = renderTopBar("Demo Project");

		expect(screen.queryByRole("tab")).not.toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "topbar.modes.rec" })).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "topbar.toggleChatPanel" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "rec.startRecording" }));
		expect(onRecord).toHaveBeenCalledOnce();
	});

	it("groups Record with Export instead of leaving it loose in the title bar", () => {
		renderTopBar("Demo Project");
		const record = screen.getByRole("button", { name: "rec.startRecording" });
		const exportButton = screen.getByRole("button", { name: "topbar.export" });

		expect(record.parentElement).toBe(exportButton.parentElement);
	});

	it("keeps a compact media import action in the editor", () => {
		const { onImportMedia } = renderTopBar("Demo Project");

		fireEvent.click(screen.getByRole("button", { name: "mediaStage.importMedia" }));
		expect(onImportMedia).toHaveBeenCalledOnce();
	});

	it("announces save state as quiet status text", () => {
		renderTopBar("Demo Project");

		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(screen.getByText("topbar.saved")).toHaveAttribute("data-on", "true");
		expect(screen.getByText("topbar.unsaved")).toHaveAttribute("data-on", "false");
	});

	it("exposes automatic-edit regeneration as one editor action", () => {
		const { onRegenerate } = renderTopBar("Demo Project");

		fireEvent.click(screen.getByRole("button", { name: "topbar.regenerateAutomaticEdits" }));
		expect(onRegenerate).toHaveBeenCalledOnce();
	});
});

describe("ProjectNameField (issue #180)", () => {
	it("renders the project title on the button", () => {
		renderTopBar("Demo Project");
		expect(screen.getByRole("button", { name: "topbar.renameProject" })).toHaveTextContent(
			"Demo Project",
		);
	});

	it("shows a placeholder and is disabled when no project is loaded", () => {
		renderTopBar(null);
		const button = screen.getByRole("button", { name: "topbar.renameProject" });
		expect(button).toBeDisabled();
		expect(button).toHaveTextContent("topbar.noProject");
	});

	it("swaps to an input pre-filled with the title on click and selects it", () => {
		renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox") as HTMLInputElement;
		expect(input.value).toBe("Demo Project");
		// The text is selected on focus, so a keystroke replaces the whole title.
		fireEvent.change(input, { target: { value: "Renamed" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(input).not.toBeInTheDocument();
	});

	it("commits a typed title on Enter via onRename", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Renamed" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).toHaveBeenCalledWith("Renamed");
	});

	it("commits on blur when the title was edited", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Blurred rename" } });
		fireEvent.blur(input);
		expect(onRename).toHaveBeenCalledWith("Blurred rename");
	});

	it("rejects an empty / whitespace-only rename", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("cancels on Escape without calling onRename", () => {
		const { onRename } = renderTopBar("Demo Project");
		fireEvent.click(screen.getByRole("button", { name: "topbar.renameProject" }));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Half-typed" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "topbar.renameProject" })).toHaveTextContent(
			"Demo Project",
		);
	});

	it("keeps the rename button in the no-drag region (regression for #180)", () => {
		// The pre-fix button used `style={{ all: "unset" }}` which clobbered the
		// topbar's `-webkit-app-region: no-drag` rule. In the Electron build the
		// button then becomes a window-drag handle and the click never fires the
		// onClick handler. The CSS module class must keep the no-drag property.
		renderTopBar("Demo Project");
		const button = screen.getByRole("button", { name: "topbar.renameProject" });
		// jsdom doesn't honour `-webkit-app-region`, so assert the marker
		// indirectly via the inline-style rule we removed: the pre-fix button
		// had `all: unset`; if any element still has it, the regression is back.
		expect(button.getAttribute("style") ?? "").not.toMatch(/all\s*:\s*unset/);
	});
});

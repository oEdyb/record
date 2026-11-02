// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutsProvider, useShortcuts } from "./ShortcutsContext";

describe("ShortcutsProvider render boundaries", () => {
	beforeEach(() => {
		window.electronAPI = {
			getShortcuts: vi.fn(async () => null),
			getPlatform: () => "darwin",
		} as unknown as Window["electronAPI"];
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("does not rerender shortcut consumers only because the dialog opens", () => {
		let renders = 0;
		function EditorConsumer() {
			renders += 1;
			const { openConfig } = useShortcuts();
			return (
				<button type="button" onClick={openConfig}>
					Open settings
				</button>
			);
		}

		render(
			<ShortcutsProvider>
				<EditorConsumer />
			</ShortcutsProvider>,
		);
		const beforeOpen = renders;

		fireEvent.click(screen.getByRole("button", { name: "Open settings" }));

		expect(renders).toBe(beforeOpen);
	});
});

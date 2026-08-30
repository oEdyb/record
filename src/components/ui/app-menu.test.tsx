// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	AppMenu,
	AppMenuContent,
	AppMenuRadioGroup,
	AppMenuRadioItem,
	AppMenuTrigger,
} from "./app-menu";

function LanguageMenu({ onChange = () => undefined }: { onChange?: (value: string) => void }) {
	const [language, setLanguage] = useState("en");
	return (
		<AppMenu>
			<AppMenuTrigger asChild>
				<button type="button">Language</button>
			</AppMenuTrigger>
			<AppMenuContent aria-label="Language">
				<AppMenuRadioGroup
					value={language}
					onValueChange={(value) => {
						setLanguage(value);
						onChange(value);
					}}
				>
					<AppMenuRadioItem value="en">English</AppMenuRadioItem>
					<AppMenuRadioItem value="sv">Svenska</AppMenuRadioItem>
				</AppMenuRadioGroup>
			</AppMenuContent>
		</AppMenu>
	);
}

describe("AppMenu", () => {
	it("composes the trigger and exposes semantic radio options", () => {
		render(<LanguageMenu />);

		const trigger = screen.getByRole("button", { name: "Language" });
		fireEvent.keyDown(trigger, { key: "ArrowDown" });

		expect(screen.getByRole("menu", { name: "Language" })).toBeInTheDocument();
		expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(trigger).toHaveAttribute("aria-haspopup", "menu");
	});

	it("selects an option and returns focus to the trigger", async () => {
		const onChange = vi.fn();
		render(<LanguageMenu onChange={onChange} />);

		const trigger = screen.getByRole("button", { name: "Language" });
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Svenska" }));

		expect(onChange).toHaveBeenCalledWith("sv");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		await waitFor(() => expect(trigger).toHaveFocus());
	});

	it("uses the editor accent and contains no green theme literal", () => {
		const css = readFileSync(
			join(process.cwd(), "src", "components", "ui", "app-menu.module.css"),
			"utf8",
		);

		expect(css).toContain("var(--editor-accent-strong)");
		expect(css).toContain("var(--radix-dropdown-menu-content-transform-origin)");
		expect(css).not.toMatch(/(?:green|emerald|lime|#10b981|#22c55e|#34b27b)/i);
	});
});

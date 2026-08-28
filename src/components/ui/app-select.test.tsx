// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AppSelect } from "./app-select";

function Fixture() {
	const [value, setValue] = useState("");
	return (
		<AppSelect
			aria-label="Delivery preset"
			value={value}
			onChange={(event) => setValue(event.target.value)}
		>
			<optgroup label="Built in">
				<option value="">Original</option>
				<option value="youtube">YouTube</option>
			</optgroup>
			<option value="custom">Custom</option>
		</AppSelect>
	);
}

function sourceFiles(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(tsx|jsx)$/.test(name) && !name.endsWith(".test.tsx") ? [path] : [];
	});
}

describe("AppSelect", () => {
	it("supports empty values, option groups, and keyboard selection", () => {
		render(<Fixture />);

		const trigger = screen.getByRole("combobox", { name: "Delivery preset" });
		expect(trigger).toHaveTextContent("Original");
		fireEvent.keyDown(trigger, { key: "ArrowDown" });
		expect(screen.getByRole("group", { name: "Built in" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("option", { name: "Custom" }));
		expect(trigger).toHaveTextContent("Custom");
	});

	it("keeps every component option menu on the shared primitive", () => {
		const componentRoot = join(process.cwd(), "src", "components");
		const nativeSelects = sourceFiles(componentRoot).filter((path) =>
			/<select(?:\s|>)/.test(readFileSync(path, "utf8")),
		);

		expect(nativeSelects).toEqual([]);
	});

	it("uses semantic editor tokens and contains no green theme literal", () => {
		const css = readFileSync(
			join(process.cwd(), "src", "components", "ui", "app-select.module.css"),
			"utf8",
		);

		expect(css).toContain("var(--editor-accent-soft)");
		expect(css).not.toMatch(/(?:green|emerald|lime|#10b981|#22c55e|#34b27b)/i);
	});
});

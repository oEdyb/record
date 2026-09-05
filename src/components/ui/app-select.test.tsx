// @vitest-environment jsdom
import "@testing-library/jest-dom";
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
});

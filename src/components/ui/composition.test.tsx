// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tooltip, TooltipProvider } from "./tooltip";

describe("composed Radix triggers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards refs when a tooltip wraps a popover trigger", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		render(
			<TooltipProvider delayDuration={0}>
				<Popover>
					<Tooltip content="Enhance">
						<PopoverTrigger asChild>
							<button type="button">Open tools</button>
						</PopoverTrigger>
					</Tooltip>
					<PopoverContent animated={false}>Enhancement tools</PopoverContent>
				</Popover>
			</TooltipProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open tools" }));

		expect(screen.getByText("Enhancement tools")).toBeInTheDocument();
		expect(
			consoleError.mock.calls.some((args) =>
				args.some(
					(value) =>
						typeof value === "string" && value.includes("Function components cannot be given refs"),
				),
			),
		).toBe(false);
	});
});

// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CountdownOverlay } from "./CountdownOverlay";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

describe("CountdownOverlay", () => {
	it("announces each digit and says how to cancel", () => {
		let push: (value: number) => void = () => undefined;
		window.electronAPI = {
			...window.electronAPI,
			onCountdownOverlayValue: (handler: (value: number) => void) => {
				push = handler;
				return () => undefined;
			},
		};
		render(<CountdownOverlay />);
		expect(screen.queryByRole("status")).toBeNull();

		act(() => push(3));
		expect(screen.getByRole("status")).toHaveTextContent("3");
		expect(screen.getByRole("status")).toHaveAttribute("aria-live", "assertive");
		expect(screen.getByText("countdown.cancelHint")).toBeInTheDocument();

		act(() => push(2));
		expect(screen.getByRole("status")).toHaveTextContent("2");
	});
});

// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { toast } from "sonner";
import { expect, it, vi } from "vitest";
import { Toaster } from "./sonner";

vi.mock("sonner", () => ({
	Toaster: () => null,
	toast: Object.assign(vi.fn(), {
		custom: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		loading: vi.fn(),
		getToasts: vi.fn(),
	}),
}));

it("replays active toasts that arrived before the lazy host", () => {
	const action = { label: "Try again", onClick: vi.fn() };
	vi.mocked(toast.getToasts).mockReturnValue([
		{ id: "dismissed", dismiss: true },
		{ id: "locale-error", title: "Language unavailable", type: "error", action },
	]);

	render(<Toaster />);

	expect(toast.error).toHaveBeenCalledExactlyOnceWith("Language unavailable", {
		id: "locale-error",
		action,
	});
	expect(toast).not.toHaveBeenCalled();
	expect(toast.custom).not.toHaveBeenCalled();
});

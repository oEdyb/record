// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { BasicCutNotice } from "./BasicCutNotice";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
afterEach(cleanup);

describe("BasicCutNotice", () => {
	it("says nothing when the AI checked the cut", () => {
		render(<BasicCutNotice modelCheck="done" />);
		render(<BasicCutNotice modelCheck={null} />);
		expect(screen.queryByText("cleanCut.basicNotice")).toBeNull();
	});

	it("names a rules-only cut, with nothing to retry when the AI is not installed", () => {
		render(<BasicCutNotice modelCheck="unavailable" />);
		expect(screen.getByText("cleanCut.basicNotice")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("offers Try again when the AI calls failed", () => {
		const before = useCleanCutStore.getState().attempt;
		render(<BasicCutNotice modelCheck="failed" />);
		fireEvent.click(screen.getByRole("button", { name: "cleanCut.retry" }));
		expect(useCleanCutStore.getState().attempt).toBe(before + 1);
	});
});

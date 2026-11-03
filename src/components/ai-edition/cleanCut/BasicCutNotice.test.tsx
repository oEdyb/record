// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { BasicCutNotice } from "./BasicCutNotice";

const bridge = vi.hoisted(() => ({ setClaudeCheck: vi.fn(async () => undefined) }));
vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("@/lib/cleanCut/bridge", () => ({ getCleanCutBridge: () => bridge }));
afterEach(cleanup);

describe("BasicCutNotice", () => {
	it("says nothing before a result exists", () => {
		render(<BasicCutNotice modelCheck={null} />);
		expect(screen.queryByTestId("clean-cut-basic")).toBeNull();
	});

	it("starts local and says the transcript leaves only after the person opts in", async () => {
		const before = useCleanCutStore.getState().attempt;
		render(<BasicCutNotice modelCheck="off" />);
		expect(screen.getByText("cleanCut.offNotice")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "cleanCut.sendTranscript" }));
		await waitFor(() => expect(bridge.setClaudeCheck).toHaveBeenCalledWith(true));
		await waitFor(() => expect(useCleanCutStore.getState().attempt).toBe(before + 1));
	});

	it("admits the transcript was sent, and turns the check off and re-runs", async () => {
		const before = useCleanCutStore.getState().attempt;
		render(<BasicCutNotice modelCheck="done" />);
		expect(screen.getByText("cleanCut.claudeCheckedNotice")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "cleanCut.turnOffClaude" }));
		await waitFor(() => expect(bridge.setClaudeCheck).toHaveBeenCalledWith(false));
		await waitFor(() => expect(useCleanCutStore.getState().attempt).toBe(before + 1));
	});

	it("names a rules-only cut, with nothing to retry when the CLI is not found", () => {
		render(<BasicCutNotice modelCheck="unavailable" />);
		expect(screen.getByText("cleanCut.basicNotice")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "cleanCut.retry" })).toBeNull();
	});

	it("offers Try again when the Claude calls failed", () => {
		const before = useCleanCutStore.getState().attempt;
		render(<BasicCutNotice modelCheck="failed" />);
		fireEvent.click(screen.getByRole("button", { name: "cleanCut.retry" }));
		expect(useCleanCutStore.getState().attempt).toBe(before + 1);
	});
});

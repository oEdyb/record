// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { TransactionRecoveryBanner as Banner } from "./TransactionRecoveryBanner";

function TransactionRecoveryBanner(): ReactElement {
	return (
		<I18nProvider>
			<Banner />
		</I18nProvider>
	);
}

const mock = vi.hoisted(() => ({
	resolve: vi.fn(),
	reconcile: vi.fn(),
	state: {
		transactionSyncPending: true,
		transactionBusy: false,
		error: null as string | null,
		transactionVersion: null as object | null,
		projectId: "p",
	},
}));
vi.mock("@/lib/ai-edition/store/projectStore", () => ({
	useProjectStore: (selector: (state: typeof mock.state) => unknown) => selector(mock.state),
	resolveLocalTransactionConflict: mock.resolve,
	reconcileProjectTransactions: mock.reconcile,
}));
beforeEach(() => {
	vi.clearAllMocks();
	mock.state.transactionSyncPending = true;
	mock.resolve.mockResolvedValue({ projectId: "copy" });
});
afterEach(cleanup);
it("does not recover or discard anything without a user choice", async () => {
	render(<TransactionRecoveryBanner />);
	expect(mock.resolve).not.toHaveBeenCalled();
	expect(mock.reconcile).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Save my version as a copy" }));
	await waitFor(() => expect(mock.resolve).toHaveBeenCalledWith("save-copy"));
});
it("labels the discard action and keeps recovery failures visible", async () => {
	mock.resolve.mockRejectedValueOnce(new Error("Receipt is still unknown"));
	render(<TransactionRecoveryBanner />);
	fireEvent.click(screen.getByRole("button", { name: "Discard unsaved changes and reload" }));
	expect(await screen.findByText("Receipt is still unknown")).toBeVisible();
	expect(mock.resolve).toHaveBeenCalledWith("reload");
});
it("checks an interrupted external edit through receipt recovery", async () => {
	render(<TransactionRecoveryBanner />);
	fireEvent.click(screen.getByRole("button", { name: "Check interrupted edit" }));
	await waitFor(() => expect(mock.reconcile).toHaveBeenCalledWith("p"));
	expect(mock.resolve).not.toHaveBeenCalled();
});
it("stays hidden without a pending save", () => {
	mock.state.transactionSyncPending = false;
	render(<TransactionRecoveryBanner />);
	expect(screen.queryByRole("alert")).toBeNull();
});

it("shows explicit recovery for a known guarded conflict without an uncertain receipt", () => {
	mock.state.transactionSyncPending = false;
	mock.state.transactionVersion = { revision: "r" };
	mock.state.error = "CONFLICT";
	render(<TransactionRecoveryBanner />);
	expect(screen.getByRole("button", { name: "Save my version as a copy" })).toBeVisible();
	expect(mock.resolve).not.toHaveBeenCalled();
});

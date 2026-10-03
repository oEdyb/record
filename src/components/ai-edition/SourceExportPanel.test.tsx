// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { nativeBridgeClient } from "@/native/client";
import { SourceExportPanel } from "./SourceExportPanel";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: { exportSources: vi.fn() } },
}));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
function documentFor(projectId = "raw") {
	const doc = createEmptyDocument({ title: "Raw", projectId });
	doc.timeline.clips = [
		{
			id: "c",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 1,
			timelineStartSec: 0,
			timelineEndSec: 1,
			wordRefs: [],
			origin: "user",
			reason: "Test",
		},
	];
	return doc;
}
function Fixture() {
	const [busy, setBusy] = useState(false);
	const [doc] = useState(documentFor);
	return <SourceExportPanel document={doc} busy={busy} onBusy={setBusy} />;
}
it("uses an explicit action and reports the saved source folder", async () => {
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockResolvedValue({
		canceled: false,
		directory: "/exports/raw",
		manifestPath: "/exports/raw/handoff.json",
		timelinePath: "/exports/raw/timeline.otio",
		sourceCount: 1,
	});
	render(<Fixture />);
	expect(screen.getByText(/Each Pause\/Continue clip/)).toHaveTextContent(
		"A recording without pauses stays one clip.",
	);
	expect(nativeBridgeClient.aiEdition.exportSources).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Export sources…" }));
	expect(await screen.findByText("Sources exported")).toBeVisible();
	expect(screen.getByText("/exports/raw")).toBeVisible();
	expect(
		screen.getByText("Import timeline.otio in your video editor to continue editing."),
	).toBeVisible();
	expect(nativeBridgeClient.aiEdition.exportSources).toHaveBeenCalledTimes(1);
	expect(screen.queryByText(/Resolve/)).toBeNull();
});
it("does not claim success after cancellation", async () => {
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockResolvedValue({ canceled: true });
	render(<Fixture />);
	fireEvent.click(screen.getByRole("button", { name: "Export sources…" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Export sources…" })).toBeEnabled(),
	);
	expect(screen.queryByText("Sources exported")).toBeNull();
});
it("shows a failure and permits a retry", async () => {
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockRejectedValue(
		new Error("Relink missing media"),
	);
	render(<Fixture />);
	fireEvent.click(screen.getByRole("button", { name: "Export sources…" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Relink missing media");
	expect(screen.getByRole("button", { name: "Export sources…" })).toBeEnabled();
});
it("locks requests synchronously even if its owner has not rerendered the busy prop", async () => {
	let finish: ((result: { canceled: boolean }) => void) | undefined;
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const onBusy = vi.fn();
	render(<SourceExportPanel document={documentFor()} busy={false} onBusy={onBusy} />);
	const button = screen.getByRole("button", { name: "Export sources…" });
	fireEvent.click(button);
	fireEvent.click(button);
	expect(nativeBridgeClient.aiEdition.exportSources).toHaveBeenCalledOnce();
	expect(onBusy).toHaveBeenCalledExactlyOnceWith(true);
	await act(async () => {
		finish?.({ canceled: true });
	});
	expect(onBusy).toHaveBeenLastCalledWith(false);
});
it("does not present a completed export as belonging to a later recording", async () => {
	let finish:
		| ((result: { canceled: boolean; directory: string; manifestPath: string }) => void)
		| undefined;
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const onBusy = vi.fn();
	const view = render(
		<SourceExportPanel document={documentFor("old")} busy={false} onBusy={onBusy} />,
	);
	fireEvent.click(screen.getByRole("button", { name: "Export sources…" }));
	view.rerender(<SourceExportPanel document={documentFor("new")} busy={true} onBusy={onBusy} />);
	await act(async () => {
		finish?.({
			canceled: false,
			directory: "/exports/old",
			manifestPath: "/exports/old/handoff.json",
		});
	});
	expect(screen.queryByText("Sources exported")).toBeNull();
	expect(screen.queryByText("/exports/old")).toBeNull();
	expect(onBusy).toHaveBeenLastCalledWith(false);
});

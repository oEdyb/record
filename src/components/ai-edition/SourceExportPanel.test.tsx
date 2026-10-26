// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
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
	render(<Fixture />, { wrapper: I18nProvider });
	expect(screen.getByText(/Every clip you recorded between pauses/)).toHaveTextContent("unchanged");
	expect(nativeBridgeClient.aiEdition.exportSources).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Save files…" }));
	expect(await screen.findByText("Files saved")).toBeVisible();
	expect(screen.getByText("/exports/raw")).toBeVisible();
	expect(
		screen.getByText(
			"Import timeline.otio / timeline.fcpxml in your video editor to keep editing.",
		),
	).toBeVisible();
	expect(nativeBridgeClient.aiEdition.exportSources).toHaveBeenCalledTimes(1);
	expect(screen.queryByText(/Resolve/)).toBeNull();
	expect(screen.queryByText(/\d+ warnings?$/)).toBeNull();
});
it("does not claim success after cancellation", async () => {
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockResolvedValue({ canceled: true });
	render(<Fixture />, { wrapper: I18nProvider });
	fireEvent.click(screen.getByRole("button", { name: "Save files…" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Save files…" })).toBeEnabled());
	expect(screen.queryByText("Files saved")).toBeNull();
});
it("shows a failure and permits a retry", async () => {
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockRejectedValue(
		new Error("Relink missing media"),
	);
	render(<Fixture />, { wrapper: I18nProvider });
	fireEvent.click(screen.getByRole("button", { name: "Save files…" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Relink missing media");
	expect(screen.getByRole("button", { name: "Save files…" })).toBeEnabled();
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
	render(<SourceExportPanel document={documentFor()} busy={false} onBusy={onBusy} />, {
		wrapper: I18nProvider,
	});
	const button = screen.getByRole("button", { name: "Save files…" });
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
		{ wrapper: I18nProvider },
	);
	fireEvent.click(screen.getByRole("button", { name: "Save files…" }));
	view.rerender(<SourceExportPanel document={documentFor("new")} busy={true} onBusy={onBusy} />);
	await act(async () => {
		finish?.({
			canceled: false,
			directory: "/exports/old",
			manifestPath: "/exports/old/handoff.json",
		});
	});
	expect(screen.queryByText("Files saved")).toBeNull();
	expect(screen.queryByText("/exports/old")).toBeNull();
	expect(onBusy).toHaveBeenLastCalledWith(false);
});

it("keeps many warnings collapsed outside the completion announcement", async () => {
	const warnings = Array.from(
		{ length: 9 },
		(_, index) => `Take ${index + 1}: source time is unavailable.`,
	);
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockResolvedValue({
		canceled: false,
		directory: "/exports/raw",
		manifestPath: "/exports/raw/handoff.json",
		warnings,
	});
	render(<Fixture />, { wrapper: I18nProvider });
	fireEvent.click(screen.getByRole("button", { name: "Save files…" }));
	await screen.findByText("Files saved");
	const disclosure = screen.getByText("9 warnings", { selector: "summary" }).closest("details")!;
	expect(disclosure).not.toHaveAttribute("open");
	expect(disclosure.querySelector("summary")).toHaveTextContent("9 warnings");
	expect(disclosure.closest('[role="status"]')).toBeNull();
	expect(screen.getByRole("button", { name: "Show in folder" })).toBeVisible();
	for (const warning of warnings) expect(screen.getByText(warning)).not.toBeVisible();
	fireEvent.click(disclosure.querySelector("summary")!);
	await waitFor(() => expect(disclosure).toHaveAttribute("open"));
	for (const warning of warnings) expect(screen.getByText(warning)).toBeVisible();
});
it("passes the clean cut to the source export and says it is included", async () => {
	vi.mocked(nativeBridgeClient.aiEdition.exportSources).mockResolvedValue({
		canceled: false,
		directory: "/exports/raw",
		manifestPath: "/exports/raw/handoff.json",
		timelinePath: "/exports/raw/timeline.otio",
		cleanCutPath: "/exports/raw/timeline-clean-cut.otio",
		sourceCount: 1,
	});
	const cleanCut = {
		keep: [{ assetId: "a", startSec: 0, endSec: 0.5 }],
		markers: [{ keepIndex: 0, name: "Retake", comment: "", color: "ORANGE" as const }],
	};
	const doc = documentFor();
	render(<SourceExportPanel document={doc} busy={false} onBusy={vi.fn()} cleanCut={cleanCut} />, {
		wrapper: I18nProvider,
	});
	expect(screen.getByText("Includes the clean cut as a second timeline.")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Save files…" }));
	expect(await screen.findByText("The clean cut timeline is in the same folder.")).toBeVisible();
	expect(nativeBridgeClient.aiEdition.exportSources).toHaveBeenCalledWith(doc, cleanCut);
});
it("saves without the clean cut while it is still working", () => {
	render(
		<SourceExportPanel
			document={documentFor()}
			busy={false}
			onBusy={vi.fn()}
			cleanCutStatus="working"
		/>,
		{ wrapper: I18nProvider },
	);
	fireEvent.click(screen.getByRole("button", { name: "Save files…" }));
	expect(
		screen.getByText("Clean cut is still working, so this save has the full timeline only."),
	).toBeVisible();
	expect(nativeBridgeClient.aiEdition.exportSources).toHaveBeenCalledWith(
		expect.anything(),
		undefined,
	);
});

import { describe, expect, it, vi } from "vitest";
import { ensureDefaultRecordingSource } from "./defaultRecordingSource";

const display: ProcessedDesktopSource = {
	id: "screen:1:0",
	name: "Display 1",
	display_id: "1",
	thumbnail: null,
	appIcon: null,
};
function api() {
	return {
		getSelectedSource: vi.fn(async (): Promise<ProcessedDesktopSource | null> => null),
		getSources: vi.fn(async () => [display]),
		selectSource: vi.fn(async (source: ProcessedDesktopSource) => source),
		getPlatform: vi.fn(() => "darwin"),
		getRecordingWorkspaceContext: vi.fn(
			async (): Promise<
				Awaited<ReturnType<Window["electronAPI"]["getRecordingWorkspaceContext"]>>
			> => ({ success: true }),
		),
	};
}
describe("fresh recorder source", () => {
	it("selects a screen without an extra source-picker click", async () => {
		const calls = api();
		expect(await ensureDefaultRecordingSource(calls, () => true)).toEqual(display);
		expect(calls.getSources).toHaveBeenCalledWith({
			types: ["screen"],
			thumbnailSize: { width: 1, height: 1 },
			fetchWindowIcons: false,
		});
		expect(calls.selectSource).toHaveBeenCalledOnce();
	});
	it("preserves an explicit source without enumerating again", async () => {
		const calls = api();
		calls.getSelectedSource.mockResolvedValue(display);
		expect(await ensureDefaultRecordingSource(calls, () => true)).toEqual(display);
		expect(calls.getSources).not.toHaveBeenCalled();
	});
	it("leaves Linux source selection with the portal", async () => {
		const calls = api();
		calls.getPlatform.mockReturnValue("linux");
		expect(await ensureDefaultRecordingSource(calls, () => true)).toBeNull();
		expect(calls.getSources).not.toHaveBeenCalled();
	});
	it("preserves a project workspace's unavailable source", async () => {
		const calls = api();
		calls.getRecordingWorkspaceContext.mockResolvedValue({
			success: true,
			context: {
				origin: "editor",
				projectId: "old",
				insertionTimeSec: 0,
				currentTimeSec: 0,
				mode: "edit",
				inspectorOpen: false,
				facet: "layout",
			},
		});
		expect(await ensureDefaultRecordingSource(calls, () => true)).toBeNull();
		expect(calls.selectSource).not.toHaveBeenCalled();
	});
	it("does not replace a manual choice made while enumeration runs", async () => {
		const calls = api();
		calls.getSelectedSource.mockResolvedValueOnce(null).mockResolvedValueOnce(display);
		await ensureDefaultRecordingSource(calls, () => true);
		expect(calls.selectSource).not.toHaveBeenCalled();
	});
	it("does not mutate selection after the HUD unmounts", async () => {
		const calls = api();
		let current = true;
		calls.getSources.mockImplementation(async () => {
			current = false;
			return [display];
		});
		expect(await ensureDefaultRecordingSource(calls, () => current)).toBeNull();
		expect(calls.selectSource).not.toHaveBeenCalled();
	});
	it("ignores windows and leaves an empty source list recoverable", async () => {
		const calls = api();
		calls.getSources.mockResolvedValue([{ ...display, id: "window:9:0" }]);
		expect(await ensureDefaultRecordingSource(calls, () => true)).toBeNull();
		expect(calls.selectSource).not.toHaveBeenCalled();
	});
	it("does not change the source when screen permission or enumeration fails", async () => {
		const calls = api();
		calls.getSources.mockRejectedValue(new Error("screen access denied"));
		await expect(ensureDefaultRecordingSource(calls, () => true)).rejects.toThrow(
			"screen access denied",
		);
		expect(calls.selectSource).not.toHaveBeenCalled();
	});
});

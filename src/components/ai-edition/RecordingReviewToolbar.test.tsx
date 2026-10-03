// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingReviewToolbar } from "./RecordingReviewToolbar";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
afterEach(cleanup);
function props() {
	return {
		title: "Recording",
		canSave: true,
		readOnly: false,
		busy: false,
		percent: null,
		entitlementLabel: null,
		onRecordings: vi.fn(),
		onRecord: vi.fn(),
		onSave: vi.fn(),
		onOriginals: vi.fn(),
		onSettings: vi.fn(),
		onEntitlement: vi.fn(),
	};
}
describe("recording review", () => {
	it("blocks stale recording actions while the newest capture is being loaded", () => {
		const actions = props();
		render(<RecordingReviewToolbar {...actions} preparing />);
		for (const name of [
			"recordingReview.preparing",
			"recordingReview.record",
			"recordingReview.recordings",
			"recordingReview.originals",
		]) {
			const button = screen.getByRole("button", { name });
			expect(button).toBeDisabled();
			fireEvent.click(button);
		}
		expect(actions.onSave).not.toHaveBeenCalled();
		expect(actions.onRecord).not.toHaveBeenCalled();
		expect(actions.onRecordings).not.toHaveBeenCalled();
		expect(actions.onOriginals).not.toHaveBeenCalled();
	});
	it("exposes capture and delivery without editing controls", () => {
		const actions = props();
		render(<RecordingReviewToolbar {...actions} />);
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.record" }));
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.save" }));
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.recordings" }));
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.originals" }));
		expect(actions.onRecord).toHaveBeenCalledOnce();
		expect(actions.onSave).toHaveBeenCalledOnce();
		expect(actions.onRecordings).toHaveBeenCalledOnce();
		expect(actions.onOriginals).toHaveBeenCalledOnce();
		expect(
			screen.queryByRole("button", { name: /caption|zoom|trim|import|regenerate/i }),
		).toBeNull();
	});
	it("keeps original-file recovery available with expired access", () => {
		render(<RecordingReviewToolbar {...props()} readOnly />);
		expect(screen.getByRole("button", { name: "recordingReview.record" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "recordingReview.save" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "recordingReview.originals" })).toBeEnabled();
	});
	it("can reopen a running save while preventing a new capture", () => {
		const actions = props();
		render(<RecordingReviewToolbar {...actions} busy percent={42} />);
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.saving" }));
		expect(actions.onSave).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "recordingReview.record" })).toBeDisabled();
	});
});

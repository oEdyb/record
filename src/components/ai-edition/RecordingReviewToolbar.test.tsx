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
	it("offers Expand only while review is the small player", () => {
		const expand = vi.fn();
		const view = render(<RecordingReviewToolbar {...props()} onExpand={expand} />);
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.expand" }));
		expect(expand).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "recordingReview.originals" })).toBeEnabled();
		view.rerender(<RecordingReviewToolbar {...props()} />);
		expect(screen.queryByRole("button", { name: "recordingReview.expand" })).toBeNull();
	});
	it("offers Add clip once there is a recording to add to", () => {
		const addClip = vi.fn();
		const view = render(
			<RecordingReviewToolbar {...props()} canSave={false} onAddClip={addClip} />,
		);
		expect(screen.queryByRole("button", { name: "recordingReview.addClip" })).toBeNull();
		view.rerender(<RecordingReviewToolbar {...props()} onAddClip={addClip} />);
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.addClip" }));
		expect(addClip).toHaveBeenCalledOnce();
		view.rerender(<RecordingReviewToolbar {...props()} readOnly onAddClip={addClip} />);
		expect(screen.getByRole("button", { name: "recordingReview.addClip" })).toBeDisabled();
	});
	it("replaces endless preparation with a retryable retained-handoff error", () => {
		const retry = vi.fn();
		render(
			<RecordingReviewToolbar
				{...props()}
				preparing
				handoffError="Could not read the recovered clip"
				onRetryHandoff={retry}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("Could not read the recovered clip");
		expect(screen.queryByText("recordingReview.preparing")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.retryOpen" }));
		expect(retry).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "recordingReview.record" })).toBeDisabled();
	});
	it("keeps an interruption visible with retry and original recovery", () => {
		const actions = props();
		const interruptions = [{ code: "writer-failed", message: "The writer stopped." }];
		const { rerender } = render(
			<RecordingReviewToolbar {...actions} interruptions={interruptions} />,
		);
		expect(screen.getByRole("status")).toHaveTextContent("recordingReview.interrupted");
		expect(screen.getByText("The writer stopped.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.recordAgain" }));
		expect(actions.onRecord).toHaveBeenCalledOnce();
		rerender(<RecordingReviewToolbar {...actions} interruptions={interruptions} readOnly />);
		expect(screen.getByRole("button", { name: "recordingReview.recordAgain" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "recordingReview.originals" })).toBeEnabled();
	});
	it("shows pending feedback on Record while opening the recorder", () => {
		render(<RecordingReviewToolbar {...props()} preparing openingRecorder isMac />);
		expect(screen.getByRole("button", { name: "recordingReview.record" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(screen.getByRole("button", { name: "recordingReview.save" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "recordingReview.record" })).toHaveAttribute(
			"aria-keyshortcuts",
			"Meta+N",
		);
	});
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
		const recordings = screen.getByRole("button", { name: "recordingReview.recordings" });
		expect(recordings).toBeDisabled();
		fireEvent.click(recordings);
		expect(actions.onRecordings).not.toHaveBeenCalled();
	});
});

it.each([
	null,
	Number.NaN,
	Number.POSITIVE_INFINITY,
])("does not invent a percentage for unknown progress %s", (percent) => {
	render(<RecordingReviewToolbar {...props()} busy percent={percent} />);
	expect(screen.getByRole("button", { name: "exportDialog.saving" })).toBeEnabled();
	expect(screen.queryByText("recordingReview.saving")).toBeNull();
});

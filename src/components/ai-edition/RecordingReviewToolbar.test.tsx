// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingReviewToolbar } from "./RecordingReviewToolbar";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
afterEach(cleanup);
function menuItem(name: string) {
	if (!screen.queryByRole("menu")) {
		fireEvent.keyDown(screen.getByRole("button", { name: "recordingReview.more" }), {
			key: "Enter",
		});
	}
	return screen.getByRole("menuitem", { name });
}
function props() {
	return {
		title: "Recording",
		canSave: true,
		busy: false,
		percent: null,
		onRecordings: vi.fn(),
		onRecord: vi.fn(),
		onSave: vi.fn(),
		onOriginals: vi.fn(),
		onSettings: vi.fn(),
	};
}
describe("recording review", () => {
	it("offers Expand only while review is the small player", () => {
		const expand = vi.fn();
		const view = render(<RecordingReviewToolbar {...props()} onExpand={expand} />);
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.expand" }));
		expect(expand).toHaveBeenCalledOnce();
		expect(menuItem("recordingReview.originals")).not.toHaveAttribute("aria-disabled");
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
		expect(screen.getByRole("button", { name: "recordingReview.newRecording" })).toBeDisabled();
	});
	it("keeps an interruption visible with retry and original recovery", () => {
		const actions = props();
		const interruptions = [{ code: "writer-failed", message: "The writer stopped." }];
		render(<RecordingReviewToolbar {...actions} interruptions={interruptions} />);
		expect(screen.getByRole("status")).toHaveTextContent("recordingReview.interrupted");
		expect(screen.getByText("The writer stopped.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.recordAgain" }));
		expect(actions.onRecord).toHaveBeenCalledOnce();
	});
	it("shows pending feedback on Record while opening the recorder", () => {
		render(<RecordingReviewToolbar {...props()} preparing openingRecorder isMac />);
		expect(screen.getByRole("button", { name: "recordingReview.newRecording" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(screen.getByRole("button", { name: "recordingReview.save" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "recordingReview.newRecording" })).toHaveAttribute(
			"aria-keyshortcuts",
			"Meta+N",
		);
	});
	it("blocks stale recording actions while the newest capture is being loaded", () => {
		const actions = props();
		render(<RecordingReviewToolbar {...actions} preparing />);
		for (const name of ["recordingReview.preparing", "recordingReview.newRecording"]) {
			const button = screen.getByRole("button", { name });
			expect(button).toBeDisabled();
			fireEvent.click(button);
		}
		for (const name of ["recordingReview.recordings", "recordingReview.originals"]) {
			const item = menuItem(name);
			expect(item).toHaveAttribute("aria-disabled", "true");
			fireEvent.click(item);
		}
		expect(actions.onSave).not.toHaveBeenCalled();
		expect(actions.onRecord).not.toHaveBeenCalled();
		expect(actions.onRecordings).not.toHaveBeenCalled();
		expect(actions.onOriginals).not.toHaveBeenCalled();
	});
	it("exposes capture and delivery without editing controls", () => {
		const actions = props();
		render(<RecordingReviewToolbar {...actions} />);
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.newRecording" }));
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.save" }));
		fireEvent.click(menuItem("recordingReview.recordings"));
		fireEvent.click(menuItem("recordingReview.originals"));
		expect(actions.onRecord).toHaveBeenCalledOnce();
		expect(actions.onSave).toHaveBeenCalledOnce();
		expect(actions.onRecordings).toHaveBeenCalledOnce();
		expect(actions.onOriginals).toHaveBeenCalledOnce();
		expect(
			screen.queryByRole("button", { name: /caption|zoom|trim|import|regenerate/i }),
		).toBeNull();
	});
	it("can reopen a running save while preventing a new capture", () => {
		const actions = props();
		render(<RecordingReviewToolbar {...actions} busy percent={42} />);
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.saving" }));
		expect(actions.onSave).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "recordingReview.newRecording" })).toBeDisabled();
		const recordings = menuItem("recordingReview.recordings");
		expect(recordings).toHaveAttribute("aria-disabled", "true");
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

describe("clean cut toggle", () => {
	it("shows Clean cut beside Save and reports its progress, result and failure", () => {
		const toggle = vi.fn();
		const cut = {
			enabled: false,
			state: "off" as const,
			progress: null,
			fromSec: 1437,
			toSec: null,
			onToggle: toggle,
		};
		const view = render(<RecordingReviewToolbar {...props()} meta="23:57 total" cleanCut={cut} />);
		const button = screen.getByRole("button", { name: "cleanCut.toggle" });
		expect(button).toHaveAttribute("aria-pressed", "false");
		expect(button.nextElementSibling).toHaveTextContent("recordingReview.save");
		fireEvent.click(button);
		expect(toggle).toHaveBeenCalledOnce();
		expect(screen.getByText("23:57 total")).toBeInTheDocument();

		view.rerender(
			<RecordingReviewToolbar
				{...props()}
				cleanCut={{ ...cut, enabled: true, state: "working", progress: 0.42 }}
			/>,
		);
		expect(screen.getByRole("button", { name: "cleanCut.toggle" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(screen.getByText("cleanCut.finding")).toBeInTheDocument();
		expect(screen.getByText("42%")).toBeInTheDocument();

		view.rerender(
			<RecordingReviewToolbar
				{...props()}
				cleanCut={{ ...cut, enabled: true, state: "working", progress: 0.7, stage: "checking" }}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("cleanCut.stage.checking70%");

		view.rerender(
			<RecordingReviewToolbar
				{...props()}
				cleanCut={{
					...cut,
					enabled: true,
					state: "ready",
					progress: 1,
					toSec: 894,
				}}
			/>,
		);
		expect(screen.getByText("cleanCut.ready")).toBeInTheDocument();
		expect(screen.getByText("23:57")).toBeInTheDocument();
		expect(screen.getByRole("timer", { name: "14:54" })).toBeInTheDocument();

		view.rerender(
			<RecordingReviewToolbar {...props()} cleanCut={{ ...cut, enabled: true, state: "failed" }} />,
		);
		expect(screen.getByText("cleanCut.failed")).toBeInTheDocument();
	});
	it("keeps Return from turning Clean cut off while the review is open", () => {
		const cut = {
			enabled: true,
			state: "ready" as const,
			progress: 1,
			fromSec: 1437,
			toSec: 894,
			onToggle: vi.fn(),
		};
		const view = render(<RecordingReviewToolbar {...props()} cleanCut={cut} />);
		const button = screen.getByRole("button", { name: "cleanCut.toggle" });
		expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(false);
		view.rerender(<RecordingReviewToolbar {...props()} cleanCut={{ ...cut, enabled: false }} />);
		expect(
			fireEvent.keyDown(screen.getByRole("button", { name: "cleanCut.toggle" }), { key: "Enter" }),
		).toBe(true);
	});
	it("hides Clean cut until there is a recording", () => {
		render(
			<RecordingReviewToolbar
				{...props()}
				canSave={false}
				cleanCut={{
					enabled: false,
					state: "off",
					progress: null,
					fromSec: 0,
					toSec: null,
					onToggle: vi.fn(),
				}}
			/>,
		);
		expect(screen.queryByRole("button", { name: "cleanCut.toggle" })).toBeNull();
	});

	it("opens the cut review from a button that shows how many cuts there are", () => {
		const onReview = vi.fn();
		render(
			<RecordingReviewToolbar
				{...props()}
				cleanCut={{
					enabled: true,
					state: "ready",
					progress: 1,
					fromSec: 52,
					toSec: 26,
					onToggle: vi.fn(),
					cutCount: 5,
					onReview,
				}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "cleanCut.reviewCuts 5" }));
		expect(onReview).toHaveBeenCalled();
	});

	it("shows a recording problem as one warning mark whose details open on a click", () => {
		const onRecord = vi.fn();
		render(
			<RecordingReviewToolbar
				{...props()}
				onRecord={onRecord}
				interruptions={[{ code: "original-track-failed", message: "Camera sent no frames." }]}
			/>,
		);
		expect(screen.queryByRole("img", { name: "Klippt" })).toBeNull();
		fireEvent.click(screen.getByTitle("recordingReview.interrupted"));
		expect(screen.getByText("Camera sent no frames.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "recordingReview.recordAgain" }));
		expect(onRecord).toHaveBeenCalled();
	});
});

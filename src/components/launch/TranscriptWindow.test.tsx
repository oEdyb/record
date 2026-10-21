// @vitest-environment jsdom

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { TranscriptWindow, transcriptClipboardText } from "./TranscriptWindow";

type Snapshot = Awaited<ReturnType<Window["electronAPI"]["getTranscriptSnapshot"]>>;

const idle: Snapshot = {
	recordingId: 7,
	clips: [
		{ index: 0, durationMs: 23_000, text: "First we need some data.", words: null, error: null },
		{ index: 3, durationMs: 5_000, text: "Then we clean it up.", words: null, error: null },
	],
	status: "idle",
	progress: null,
	download: null,
	error: null,
	updatedAt: 1,
};

let updated: ((snapshot: Snapshot) => void) | null = null;
const refreshTranscript = vi.fn<() => Promise<Snapshot>>();
const writeClipboardText = vi.fn(async () => undefined);
const closeTranscriptWindow = vi.fn();

beforeEach(() => {
	updated = null;
	refreshTranscript.mockReset().mockResolvedValue(idle);
	writeClipboardText.mockClear();
	closeTranscriptWindow.mockClear();
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			getTranscriptSnapshot: vi.fn(async () => ({ ...idle, clips: [] })),
			refreshTranscript,
			onTranscriptUpdated: vi.fn((callback: (snapshot: Snapshot) => void) => {
				updated = callback;
				return vi.fn();
			}),
			writeClipboardText,
			closeTranscriptWindow,
		},
	});
});

afterEach(() => {
	cleanup();
});

function renderWindow() {
	return render(
		<I18nProvider>
			<TranscriptWindow />
		</I18nProvider>,
	);
}

describe("TranscriptWindow", () => {
	it("refreshes on open and lists every clip with its start time", async () => {
		renderWindow();
		await waitFor(() => expect(refreshTranscript).toHaveBeenCalledOnce());
		const clips = await screen.findAllByTestId("transcript-clip");
		expect(clips).toHaveLength(2);
		expect(clips[0]).toHaveTextContent("Clip 1 · 0:00");
		expect(clips[1]).toHaveTextContent("Clip 4 · 0:23");
		expect(clips[1]).toHaveTextContent("Then we clean it up.");
	});

	it("copies the whole transcript as plain paragraphs", async () => {
		renderWindow();
		await screen.findAllByTestId("transcript-clip");
		fireEvent.click(screen.getByTestId("transcript-copy"));
		await waitFor(() =>
			expect(writeClipboardText).toHaveBeenCalledWith(
				"First we need some data.\n\nThen we clean it up.",
			),
		);
		expect(screen.getByTestId("transcript-copy")).toHaveTextContent("Copied");
	});

	it("shows pushed progress and blocks Refresh while the helper works", async () => {
		renderWindow();
		await screen.findAllByTestId("transcript-clip");
		act(() => {
			updated?.({ ...idle, status: "transcribing", progress: { done: 1, total: 3 } });
		});
		expect(screen.getByRole("status")).toHaveTextContent("Transcribing clip 2 of 3");
		expect(screen.getByTestId("transcript-refresh")).toBeDisabled();
		act(() => {
			updated?.({ ...idle, status: "blocked" });
		});
		expect(screen.getByRole("status")).toHaveTextContent("Pause the recording");
	});

	it("builds clipboard text from transcribed clips only", () => {
		expect(
			transcriptClipboardText({
				...idle,
				clips: [...idle.clips, { index: 5, durationMs: 1, text: null, words: null, error: "x" }],
			}),
		).toBe("First we need some data.\n\nThen we clean it up.");
	});
});

// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { PauseSuggestion } from "@/lib/ai-edition/timeline/pause-analysis";
import type { ProjectPauseAnalysisResult } from "./pauses/analyzeProjectPauses";
import {
	resetPauseAnalysisStoreForTests,
	usePauseAnalysisStore,
} from "./pauses/pauseAnalysisStore";

const analyze = vi.fn();

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, variables?: Record<string, string | number>) =>
		variables ? `${key} ${Object.values(variables).join(" ")}` : key,
}));

vi.mock("./pauses/analyzeProjectPauses", () => ({
	analyzeProjectPauses: (...args: unknown[]) => analyze(...args),
}));

import { AudioPane } from "./AudioPane";

const candidates: PauseSuggestion[] = [
	{
		id: "pause-1",
		kind: "pause",
		clipId: "clip-1",
		assetId: "asset-1",
		silenceStartSec: 1,
		silenceEndSec: 2.4,
		sourceStartSec: 1.2,
		sourceEndSec: 2.2,
		timelineStartSec: 1.2,
		timelineEndSec: 2.2,
		savedSec: 1,
	},
	{
		id: "pause-2",
		kind: "pause",
		clipId: "clip-1",
		assetId: "asset-1",
		silenceStartSec: 4,
		silenceEndSec: 5.4,
		sourceStartSec: 4.2,
		sourceEndSec: 5.2,
		timelineStartSec: 4.2,
		timelineEndSec: 5.2,
		savedSec: 1,
	},
];

function documentFixture() {
	const document = createEmptyDocument({
		projectId: "project-1",
		title: "Pauses",
	});
	document.assets.push({
		id: "asset-1",
		kind: "video",
		label: "Recording",
		originalPath: "/recording.mp4",
		durationSec: 8,
		cameraTrack: null,
	});
	document.timeline.clips.push({
		id: "clip-1",
		assetId: "asset-1",
		sourceStartSec: 0,
		sourceEndSec: 8,
		timelineStartSec: 0,
		timelineEndSec: 8,
		wordRefs: [],
		origin: "user",
		reason: "",
	});
	return document;
}

function Harness({ onPreview }: { onPreview: ComponentProps<typeof AudioPane>["onPreview"] }) {
	return (
		<TooltipProvider delayDuration={0}>
			<AudioPane onPreview={onPreview} />
		</TooltipProvider>
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	resetPauseAnalysisStoreForTests();
	analyze.mockReset();
	analyze.mockResolvedValue({
		suggestions: candidates,
		analyzedClipCount: 1,
		missingTranscript: false,
		missingMicrophone: false,
		usedMixedAudio: false,
	});
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: () => null,
			setItem: vi.fn(),
		},
	});
	useProjectStore.setState({
		projectId: "project-1",
		document: documentFixture(),
		revision: 1,
		status: "ready",
		saveDocument: vi.fn(async () => true),
		saveDocumentAsEdit: vi.fn(async () => true),
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("AudioPane", () => {
	it("uses the shared themed select primitive instead of native option menus", () => {
		const { container } = render(<Harness onPreview={vi.fn()} />);

		expect(container.querySelector("select")).not.toBeInTheDocument();
	});

	it("keeps the audio workflow clear and saves independent project controls", async () => {
		render(<Harness onPreview={vi.fn()} />);

		const cleanVoice = screen.getByRole("switch", { name: "audio.cleanVoice" });
		expect(cleanVoice).toBeDisabled();
		expect(screen.getByText("audio.youtubeTarget")).toBeInTheDocument();
		expect(screen.queryByText("audio.voiceDescription")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "audio.voice: audio.voiceDescription",
			}),
		).toBeInTheDocument();

		const evenVolume = screen.getByRole("switch", { name: "audio.evenVolume" });
		fireEvent.click(evenVolume);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "panels.delivery" }), {
			button: 0,
			ctrlKey: false,
		});
		const normalizeVolume = screen.getByRole("switch", {
			name: "audio.normalizeVolume",
		});
		expect(evenVolume).toHaveAttribute("aria-checked", "false");
		expect(normalizeVolume).toHaveAttribute("aria-checked", "true");

		fireEvent.click(normalizeVolume);
		await act(async () => undefined);

		const current = useProjectStore.getState().document;
		expect(getEditorSettings(current)).toMatchObject({
			evenVolume: false,
			normalizeVolume: false,
		});
	});

	it("enables Clean Voice as one reversible project edit when the local worker is available", async () => {
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: {
				getCleanVoiceRuntime: vi.fn(async () => ({ available: true, assets: [] })),
				onCleanVoiceStatus: vi.fn(() => () => undefined),
			},
		});
		const applyPatch = vi.fn(async (_projectId, patch) => {
			const current = useProjectStore.getState().document;
			if (current) useProjectStore.setState({ document: patch(current) });
			return "applied" as const;
		});
		useProjectStore.setState({ applyDocumentPatch: applyPatch });
		render(<Harness onPreview={vi.fn()} />);

		await act(async () => undefined);
		const cleanVoice = screen.getByRole("switch", { name: "audio.cleanVoice" });
		expect(cleanVoice).toBeEnabled();
		fireEvent.click(cleanVoice);
		await act(async () => undefined);

		expect(applyPatch).toHaveBeenCalledOnce();
		expect(useProjectStore.getState().document?.assets[0]?.cleanVoice).toEqual({
			version: 1,
			mode: "natural",
			engine: "deepfilternet3",
			attenuationLimitDb: 6,
			postFilter: false,
		});
	});

	it("stores custom loudness and peak targets as real project settings", async () => {
		render(<Harness onPreview={vi.fn()} />);

		fireEvent.mouseDown(screen.getByRole("tab", { name: "panels.delivery" }), {
			button: 0,
			ctrlKey: false,
		});
		const preset = screen.getByRole("combobox", { name: "audio.preset" });
		fireEvent.keyDown(preset, { key: "ArrowDown" });
		fireEvent.click(screen.getByRole("option", { name: "audio.custom" }));
		await act(async () => undefined);

		const loudness = screen.getByRole("slider", {
			name: "audio.targetLoudness",
		});
		const peak = screen.getByRole("slider", { name: "audio.peakCeiling" });
		for (let index = 0; index < 7; index += 1) {
			fireEvent.keyDown(loudness, { key: "ArrowLeft" });
		}
		fireEvent.keyUp(loudness, { key: "ArrowLeft" });
		for (let index = 0; index < 2; index += 1) {
			fireEvent.keyDown(peak, { key: "ArrowLeft" });
		}
		fireEvent.keyUp(peak, { key: "ArrowLeft" });
		await act(async () => undefined);

		expect(getEditorSettings(useProjectStore.getState().document)).toMatchObject({
			audioDeliveryPreset: "custom",
			audioTargetLufs: -18,
			audioPeakCeilingDbtp: -3,
		});
	});

	it("waits for an explicit scan, then previews candidates and applies one batch edit", async () => {
		const preview = vi.fn();
		const applyPatch = vi.fn(async (..._arguments: unknown[]) => "applied" as const);
		useProjectStore.setState({ applyDocumentPatch: applyPatch });
		render(<Harness onPreview={preview} />);

		await act(async () => vi.advanceTimersByTimeAsync(500));
		expect(analyze).not.toHaveBeenCalled();

		fireEvent.mouseDown(screen.getByRole("tab", { name: "panels.pauses" }), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(screen.getByRole("button", { name: "pauses.analyze" }));
		await act(async () => undefined);
		expect(screen.getByText(/pauses.resultCount 2/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /pauses.preview/ }));
		expect(preview).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: "pause-1" })]),
		);

		fireEvent.click(screen.getByRole("button", { name: /pauses.acceptAll 2/ }));
		await act(async () => undefined);
		expect(applyPatch).toHaveBeenCalledOnce();
		const applyCall = applyPatch.mock.calls[0] as unknown[] | undefined;
		expect(applyCall?.[2]).toEqual(
			expect.objectContaining({ createHistorySnapshot: expect.any(Function) }),
		);
	});

	it("keeps an explicit scan running when the Audio pane unmounts", async () => {
		let finishAnalysis: ((value: ProjectPauseAnalysisResult) => void) | undefined;
		analyze.mockImplementationOnce(
			() =>
				new Promise<ProjectPauseAnalysisResult>((resolve) => {
					finishAnalysis = resolve;
				}),
		);
		const { unmount } = render(<Harness onPreview={vi.fn()} />);

		fireEvent.mouseDown(screen.getByRole("tab", { name: "panels.pauses" }), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(screen.getByRole("button", { name: "pauses.analyze" }));
		expect(usePauseAnalysisStore.getState().status).toBe("analyzing");
		unmount();

		await act(async () => {
			finishAnalysis?.({
				suggestions: candidates,
				analyzedClipCount: 1,
				missingTranscript: false,
				missingMicrophone: false,
				missingSpeechActivity: false,
				usedMixedAudio: false,
			});
			await Promise.resolve();
		});

		expect(usePauseAnalysisStore.getState()).toMatchObject({
			projectId: "project-1",
			status: "ready",
		});
		expect(usePauseAnalysisStore.getState().suggestions).toHaveLength(2);
	});

	it("invalidates finished suggestions when the project revision changes", async () => {
		render(<Harness onPreview={vi.fn()} />);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "panels.pauses" }), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(screen.getByRole("button", { name: "pauses.analyze" }));
		await act(async () => undefined);
		expect(usePauseAnalysisStore.getState().suggestions).toHaveLength(2);

		act(() => {
			usePauseAnalysisStore.getState().syncDocument("project-1", 2);
		});

		expect(usePauseAnalysisStore.getState()).toMatchObject({
			projectId: "project-1",
			revision: 2,
			status: "idle",
			suggestions: [],
		});
	});
});

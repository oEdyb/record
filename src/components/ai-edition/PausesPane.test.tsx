// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { PauseSuggestion } from "@/lib/ai-edition/timeline/pause-analysis";

const analyze = vi.fn();

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, variables?: Record<string, string | number>) =>
		variables ? `${key} ${Object.values(variables).join(" ")}` : key,
}));

vi.mock("./pauses/analyzeProjectPauses", () => ({
	analyzeProjectPauses: (...args: unknown[]) => analyze(...args),
}));

import { PausesPane, type SelectablePauseSuggestion } from "./PausesPane";

const candidates: PauseSuggestion[] = [
	{
		id: "pause-1",
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
	const document = createEmptyDocument({ projectId: "project-1", title: "Pauses" });
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

function Harness({
	onPreview,
}: {
	onPreview: (value: SelectablePauseSuggestion[] | null) => void;
}) {
	const [suggestions, setSuggestions] = useState<SelectablePauseSuggestion[]>([]);
	const change = useCallback((next: SelectablePauseSuggestion[]) => setSuggestions(next), []);
	return (
		<PausesPane suggestions={suggestions} onSuggestionsChange={change} onPreview={onPreview} />
	);
}

beforeEach(() => {
	vi.useFakeTimers();
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
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PausesPane", () => {
	it("shows live candidates, previews selected trims, and applies one batch edit", async () => {
		const preview = vi.fn();
		const applyPatch = vi.fn(async (..._arguments: unknown[]) => "applied" as const);
		useProjectStore.setState({ applyDocumentPatch: applyPatch });
		render(<Harness onPreview={preview} />);

		await act(async () => vi.advanceTimersByTimeAsync(220));
		expect(screen.getByText(/pauses.resultCount 2/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /pauses.preview/ }));
		expect(preview).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: "pause-1" })]),
		);

		fireEvent.click(screen.getByRole("button", { name: /pauses.applySelected 2/ }));
		await act(async () => undefined);
		expect(applyPatch).toHaveBeenCalledOnce();
		const applyCall = applyPatch.mock.calls[0] as unknown[] | undefined;
		expect(applyCall?.[2]).toEqual(
			expect.objectContaining({ createHistorySnapshot: expect.any(Function) }),
		);
	});
});

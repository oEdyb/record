// @vitest-environment jsdom
// Guards the right-rail settings panes against untranslated strings creeping
// back in: every pane used to hardcode its English labels (title, tabs, slider
// labels, help popover), so switching the app locale left the whole inspector
// in English. These render each pane under a non-English locale and assert the
// localized text is what actually reaches the DOM.

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { BackgroundPane, CursorPane, LayoutPane, VideoEffectsPane } from "./RightPanes";

function renderIn(locale: string, ui: ReactElement) {
	window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	return render(<I18nProvider>{ui}</I18nProvider>);
}

function makeStackedCameraDocument(): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "project-stacked",
			title: "Stacked",
			createdAt: "2026-08-21T00:00:00.000Z",
			updatedAt: "2026-08-21T00:00:00.000Z",
			primaryAssetId: "asset-stacked",
		},
		assets: [
			{
				id: "asset-stacked",
				kind: "video",
				label: "Recording",
				originalPath: "/screen.mp4",
				cameraTrack: { sourcePath: "/camera.mp4", startMs: 0, offsetMs: 0, visible: true },
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip-stacked",
					assetId: "asset-stacked",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: {
			aspectRatio: "9:16",
			webcamLayoutPreset: "vertical-stack",
			webcamBlockCameraShare: 50,
		},
	};
}

beforeEach(() => {
	window.localStorage.clear();
	useProjectStore.getState().clear();
});

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	useProjectStore.getState().clear();
});

describe("right-rail panes are localized", () => {
	it("renders the background pane in French", () => {
		renderIn("fr", <BackgroundPane />);
		expect(screen.getByRole("heading", { name: "Arrière-plan" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Aide" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Téléverser une image" })).toBeInTheDocument();
		// wallpaper swatches interpolate their index through the catalog
		expect(screen.getByRole("button", { name: "Fond 1" })).toBeInTheDocument();
	});

	it("renders the video-effects pane in Spanish", () => {
		renderIn("es", <VideoEffectsPane />);
		const heading = screen.getByRole("heading", { name: "Efectos de video" });
		expect(heading).toBeInTheDocument();
		expect(heading.closest('[data-inspector-layout="flat"]')).toBeInTheDocument();
		expect(screen.getByText("Desenfoque de movimiento")).toBeInTheDocument();
		expect(screen.getByText("Sombra")).toBeInTheDocument();
	});

	it("renders the layout pane in Japanese", () => {
		renderIn("ja-JP", <LayoutPane />);
		const heading = screen.getByRole("heading", { name: "レイアウト" });
		expect(heading).toBeInTheDocument();
		expect(heading.closest('[data-inspector-layout="flat"]')).toBeInTheDocument();
		// the preset <option> labels come from the shared layout.* catalog
		expect(screen.getByRole("option", { name: "ピクチャーインピクチャ" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "9:16" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "9:16" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "カスタム" })).toBeInTheDocument();
		expect(screen.getByText("カメラのズーム")).toBeInTheDocument();
		expect(screen.getByText("カメラの位置")).toBeInTheDocument();
	});

	it("shows the saved camera share for the top and bottom layout", () => {
		const document = makeStackedCameraDocument();
		useProjectStore.setState({
			projectId: document.project.id,
			document,
			status: "ready",
		});
		renderIn("en", <LayoutPane />);

		const slider = screen.getByRole("slider", { name: "Camera share" });
		expect(slider).toHaveValue("50");
		expect(slider).toHaveAttribute("min", "20");
		expect(slider).toHaveAttribute("max", "80");
	});

	it("renders the cursor pane in French", () => {
		renderIn("fr", <CursorPane />);
		const heading = screen.getByRole("heading", { name: "Curseur" });
		expect(heading).toBeInTheDocument();
		expect(heading.closest('[data-inspector-layout="flat"]')).toBeInTheDocument();
		expect(screen.getByText("Lissage")).toBeInTheDocument();
		expect(screen.getByText("Rebond au clic")).toBeInTheDocument();
	});

	it("falls back to English when the locale is English", () => {
		renderIn("en", <VideoEffectsPane />);
		expect(screen.getByRole("heading", { name: "Video Effects" })).toBeInTheDocument();
		expect(screen.getByText("Blur BG")).toBeInTheDocument();
	});

	it("keeps the Background pane on the shared continuous inspector layout", () => {
		renderIn("en", <BackgroundPane />);
		const heading = screen.getByRole("heading", { name: "Background" });
		expect(heading.closest('[data-inspector-layout="flat"]')).toBeInTheDocument();
	});
});

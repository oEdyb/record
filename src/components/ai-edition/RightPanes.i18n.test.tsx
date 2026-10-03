// @vitest-environment jsdom
// Guards the right-rail settings panes against untranslated strings creeping
// back in: every pane used to hardcode its English labels (title, tabs, slider
// labels, help popover), so switching the app locale left the whole inspector
// in English. These render each pane under a non-English locale and assert the
// localized text is what actually reaches the DOM.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { BackgroundPane, CursorPane, LayoutPane, VideoEffectsPane } from "./RightPanes";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { save: vi.fn(async (document: AxcutDocument) => ({ success: true, document })) },
	},
}));

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
				cameraTrack: {
					sourcePath: "/camera.mp4",
					startMs: 0,
					offsetMs: 0,
					visible: true,
				},
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
			screenFramingByVariant: {
				"9:16": { scale: 2.2, focalPoint: { cx: 0.75, cy: 0.25 } },
			},
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
		expect(screen.getByText("Desenfoque de movimiento de pantalla")).toBeInTheDocument();
		expect(screen.getByText("Sombra de pantalla")).toBeInTheDocument();
	});

	it("renders the layout pane in Japanese", () => {
		const document = makeStackedCameraDocument();
		document.legacyEditor = {
			...document.legacyEditor,
			webcamLayoutPreset: "picture-in-picture",
		};
		useProjectStore.setState({
			projectId: document.project.id,
			document,
			status: "ready",
		});
		renderIn("ja-JP", <LayoutPane />);
		const heading = screen.getByRole("heading", { name: "レイアウト" });
		expect(heading).toBeInTheDocument();
		expect(heading.closest('[data-inspector-layout="flat"]')).toBeInTheDocument();
		const [aspectRatio] = screen.getAllByRole("combobox");
		expect(aspectRatio).toHaveTextContent("9:16");

		expect(screen.queryByRole("button", { name: "9:16" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "カスタム" })).toBeInTheDocument();
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Camera" }), { button: 0, ctrlKey: false });
		expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("ピクチャーインピクチャ");
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
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Camera" }), { button: 0, ctrlKey: false });

		const slider = screen.getByRole("slider", { name: "Camera share" });
		expect(slider).toHaveValue(50);
		expect(slider).toHaveAttribute("aria-valuemin", "20");
		expect(slider).toHaveAttribute("aria-valuemax", "80");
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Screen" }), { button: 0, ctrlKey: false });
		expect(screen.getByRole("slider", { name: "Scale" })).toHaveValue(2.2);
		expect(screen.getByRole("slider", { name: "Position" })).toHaveAttribute(
			"aria-valuetext",
			"75%, 25%",
		);
		expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
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
		expect(screen.getByText("Blur background")).toBeInTheDocument();
	});

	it("keeps the Background pane on the shared continuous inspector layout", () => {
		renderIn("en", <BackgroundPane />);
		const heading = screen.getByRole("heading", { name: "Background" });
		expect(heading.closest('[data-inspector-layout="flat"]')).toBeInTheDocument();
	});
});

describe("camera shape controls", () => {
	function loadCamera(shape: "rounded" | "circle" | "square" = "rounded") {
		const document = makeStackedCameraDocument();
		document.legacyEditor = { webcamLayoutPreset: "picture-in-picture", webcamMaskShape: shape };
		useProjectStore.setState({ projectId: document.project.id, document, status: "ready" });
	}

	it("offers a squircle and edits its corner radius without changing camera size", async () => {
		loadCamera();
		renderIn("en", <LayoutPane />);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Camera" }), { button: 0, ctrlKey: false });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Squircle" }));
		});
		expect(screen.getByRole("button", { name: "Squircle" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		const radius = screen.getByRole("slider", { name: "Camera corners" });
		expect(radius).toHaveValue(30);
		expect(radius).toHaveAttribute("aria-valuemax", "50");
		const size = screen.getByRole("slider", { name: "Webcam Size" }).getAttribute("aria-valuenow");
		await act(async () => {
			fireEvent.keyDown(radius, { key: "End" });
			fireEvent.blur(radius);
		});
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			webcamMaskShape: "squircle",
			webcamCornerRadius: 50,
		});
		expect(screen.getByRole("slider", { name: "Webcam Size" })).toHaveValue(Number(size));
		// JSDOM has no layout scrolling; Radix scrolls the selected option on open.
		Element.prototype.scrollIntoView = vi.fn();
		const ratio = screen.getByRole("combobox", { name: "Camera aspect ratio" });
		expect(ratio).toHaveTextContent("Match camera source");
		await act(async () => {
			fireEvent.keyDown(ratio, { key: "ArrowDown" });
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("option", { name: "4:3" }));
		});
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			webcamMaskShape: "squircle",
			webcamCornerRadius: 50,
			webcamAspectRatio: "4:3",
		});
	});

	it("hides corner rounding for the circle", () => {
		loadCamera("circle");
		renderIn("en", <LayoutPane />);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Camera" }), { button: 0, ctrlKey: false });
		expect(screen.queryByRole("slider", { name: "Camera corners" })).not.toBeInTheDocument();
	});

	it("keeps legacy square rounding automatic until edited", () => {
		loadCamera("square");
		renderIn("en", <LayoutPane />);
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Camera" }), { button: 0, ctrlKey: false });
		expect(
			Number(screen.getByRole("slider", { name: "Camera corners" }).getAttribute("aria-valuenow")),
		).toBeLessThan(12);
		expect(useProjectStore.getState().document?.legacyEditor?.webcamCornerRadius).toBeUndefined();
	});

	it("shows the scope of every video effect", () => {
		renderIn("en", <VideoEffectsPane />);
		for (const description of [
			"Softens the background behind the recording.",
			"Adds blur during screen zoom and pan animations.",
			"Adjusts the shadow behind the screen recording.",
			"Rounds the screen recording’s corners. Camera corners are separate.",
			"Adds space around the recording to show more background.",
		])
			expect(
				screen.getByRole("button", { name: (name) => name.endsWith(description) }),
			).toBeVisible();
	});
});

it("shows cursor size as a multiplier without changing stored units", async () => {
	const document = makeStackedCameraDocument();
	useProjectStore.setState({ projectId: document.project.id, document, status: "ready" });
	renderIn("en", <CursorPane />);
	const size = screen.getByRole("textbox", { name: "Size (×)" });
	await act(async () => {
		fireEvent.change(size, { target: { value: "2.25" } });
		fireEvent.keyDown(size, { key: "Enter" });
	});
	expect(screen.getByRole("slider", { name: "Size" })).toHaveValue(2.25);
	expect(useProjectStore.getState().document?.legacyEditor?.cursorSize).toBe(2.25);
});

it("hides camera positioning when the layout excludes the camera", () => {
	const document = makeStackedCameraDocument();
	document.legacyEditor = { webcamLayoutPreset: "no-webcam" };
	useProjectStore.setState({ projectId: document.project.id, document, status: "ready" });
	renderIn("en", <LayoutPane />);
	fireEvent.mouseDown(screen.getByRole("tab", { name: "Camera" }), { button: 0, ctrlKey: false });
	expect(screen.queryByRole("slider", { name: "Camera Position" })).not.toBeInTheDocument();
});

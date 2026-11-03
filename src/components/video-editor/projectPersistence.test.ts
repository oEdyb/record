import { describe, expect, it } from "vitest";
import { DEFAULT_CURSOR_THEME_ID } from "@/lib/cursor/cursorThemes";
import { toKlipptMediaUrl } from "@/lib/localMediaUrl";
import {
	createProjectData,
	createProjectSnapshot,
	hasProjectUnsavedChanges,
	normalizeProjectEditor,
	PROJECT_VERSION,
	resolveProjectMedia,
	validateProjectData,
	toFileUrl,
} from "./projectPersistence";

describe("file URLs with a literal percent sign", () => {
	it.each([
		["file:///clips/100%.mp4", "/clips/100%.mp4"],
		["file:///clips/100%25.mp4", "/clips/100%.mp4"],
		["file:///clips/caf%C3%A9%20100%.mp4", "/clips/café 100%.mp4"],
		["file:///clips/bad%FF%.mp4", "/clips/bad%FF%.mp4"],
		["/clips/100%.mp4", "/clips/100%.mp4"],
	])("opens %s as %s", (saved, filePath) => {
		expect(toFileUrl(saved)).toBe(toKlipptMediaUrl(filePath));
	});
});

describe("projectPersistence media compatibility", () => {
	it("accepts legacy projects with a single videoPath", () => {
		const project = {
			version: 1,
			videoPath: "/tmp/screen.webm",
			editor: {},
		};

		expect(validateProjectData(project)).toBe(true);
		expect(resolveProjectMedia(project)).toEqual({
			screenVideoPath: "/tmp/screen.webm",
		});
	});

	it("creates version 2 projects with explicit media", () => {
		const project = createProjectData(
			{
				screenVideoPath: "/tmp/screen.webm",
				webcamVideoPath: "/tmp/webcam.webm",
			},
			{
				wallpaper: "/wallpapers/wallpaper1.jpg",
				shadowIntensity: 0,
				showBlur: false,
				motionBlurAmount: 0,
				borderRadius: 0,
				padding: 50,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
				zoomRegions: [],
				cameraFullscreenRegions: [],
				autoZoomEnabled: true,
				autoFocusAll: false,
				trimRegions: [],
				speedRegions: [],
				annotationRegions: [],
				aspectRatio: "16:9",
				webcamLayoutPreset: "picture-in-picture",
				webcamBlockOrder: "screen-first",
				webcamBlockCameraShare: 50,
				webcamMaskShape: "circle",
				webcamMirrored: true,
				webcamReactiveZoom: false,
				webcamSizePreset: 25,
				webcamZoom: 1,
				webcamFocalPoint: { cx: 0.5, cy: 0.5 },
				webcamPosition: null,
				exportQuality: "good",
				exportFormat: "mp4",
				gifFrameRate: 15,
				gifLoop: true,
				gifSizePreset: "medium",
				cursorTheme: DEFAULT_CURSOR_THEME_ID,
			},
		);

		expect(project.version).toBe(PROJECT_VERSION);
		expect(project.media).toEqual({
			screenVideoPath: "/tmp/screen.webm",
			webcamVideoPath: "/tmp/webcam.webm",
		});
		expect(validateProjectData(project)).toBe(true);
	});

	it("normalizes webcam mask shape values safely", () => {
		expect(normalizeProjectEditor({ webcamMaskShape: "rounded" }).webcamMaskShape).toBe("rounded");
		expect(
			normalizeProjectEditor({ webcamMaskShape: "not-a-real-shape" as never }).webcamMaskShape,
		).toBe("rectangle");
	});

	it("normalizes webcam mirroring safely", () => {
		expect(normalizeProjectEditor({ webcamMirrored: true }).webcamMirrored).toBe(true);
		expect(normalizeProjectEditor({ webcamMirrored: false }).webcamMirrored).toBe(false);
		expect(normalizeProjectEditor({ webcamMirrored: "yes" as never }).webcamMirrored).toBe(false);
	});

	it("preserves large webcam sizes and clamps them at 80 percent", () => {
		expect(normalizeProjectEditor({ webcamSizePreset: 70 }).webcamSizePreset).toBe(70);
		expect(normalizeProjectEditor({ webcamSizePreset: 90 }).webcamSizePreset).toBe(80);
	});

	it("preserves the stacked camera share and clamps it to a useful range", () => {
		expect(normalizeProjectEditor({ webcamBlockCameraShare: 64 }).webcamBlockCameraShare).toBe(64);
		expect(normalizeProjectEditor({ webcamBlockCameraShare: 5 }).webcamBlockCameraShare).toBe(20);
		expect(normalizeProjectEditor({ webcamBlockCameraShare: 95 }).webcamBlockCameraShare).toBe(80);
	});

	it("preserves camera crop zoom and clamps it independently of webcam size", () => {
		expect(normalizeProjectEditor({ webcamZoom: 1.75 }).webcamZoom).toBe(1.75);
		expect(normalizeProjectEditor({ webcamZoom: 0.5 }).webcamZoom).toBe(1);
		expect(normalizeProjectEditor({ webcamZoom: 5 }).webcamZoom).toBe(3);
	});

	it("preserves and clamps camera focal position", () => {
		expect(
			normalizeProjectEditor({ webcamFocalPoint: { cx: 0.2, cy: 0.8 } }).webcamFocalPoint,
		).toEqual({ cx: 0.2, cy: 0.8 });
		expect(
			normalizeProjectEditor({ webcamFocalPoint: { cx: -0.5, cy: 1.5 } }).webcamFocalPoint,
		).toEqual({ cx: 0, cy: 1 });
	});

	it("round-trips a large webcam size through the saved project", () => {
		const saved = createProjectData(
			{ screenVideoPath: "/tmp/screen.webm" },
			normalizeProjectEditor({ webcamSizePreset: 78 }),
		);
		const reopened = JSON.parse(JSON.stringify(saved));

		expect(validateProjectData(reopened)).toBe(true);
		expect(normalizeProjectEditor(reopened.editor).webcamSizePreset).toBe(78);
	});

	it("preserves bounded automatic camera emphasis regions", () => {
		const editor = normalizeProjectEditor({
			cameraFullscreenRegions: [
				{
					id: "camera-emphasis",
					startMs: 1_000,
					endMs: 5_000,
					mode: "emphasis",
					cameraScale: 8,
					source: "auto",
				},
			],
		});
		expect(editor.cameraFullscreenRegions).toEqual([
			{
				id: "camera-emphasis",
				startMs: 1_000,
				endMs: 5_000,
				mode: "emphasis",
				cameraScale: 1.6,
				source: "auto",
			},
		]);
	});

	it("preserves independent zoom and camera motion styles", () => {
		const editor = normalizeProjectEditor({
			zoomRegions: [
				{
					id: "zoom-linear",
					startMs: 1_000,
					endMs: 4_000,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
					motionStyle: "linear",
					motionSpeed: 1.5,
				},
			],
			cameraFullscreenRegions: [
				{
					id: "camera-instant",
					startMs: 1_000,
					endMs: 4_000,
					mode: "emphasis",
					cameraScale: 1.35,
					motionStyle: "instant",
					motionSpeed: 0.75,
				},
			],
		});

		expect(editor.zoomRegions[0].motionStyle).toBe("linear");
		expect(editor.zoomRegions[0].motionSpeed).toBe(1.5);
		expect(editor.cameraFullscreenRegions[0].motionStyle).toBe("instant");
		expect(editor.cameraFullscreenRegions[0].motionSpeed).toBe(0.75);
	});

	it("preserves the rendered zoom scale and automatic-direction ownership", () => {
		const editor = normalizeProjectEditor({
			zoomRegions: [
				{
					id: "zoom-owned",
					startMs: 1_000,
					endMs: 4_000,
					depth: 6,
					focus: { cx: 0.5, cy: 0.5 },
					customScale: 1.52,
					source: "auto",
					directionGroupId: "screen-passage",
				},
			],
			cameraFullscreenRegions: [
				{
					id: "camera-owned",
					startMs: 5_000,
					endMs: 8_000,
					source: "auto",
					directionGroupId: "camera-passage",
				},
			],
		});

		expect(editor.zoomRegions[0]).toMatchObject({
			customScale: 1.52,
			directionGroupId: "screen-passage",
		});
		expect(editor.cameraFullscreenRegions[0]).toMatchObject({
			directionGroupId: "camera-passage",
		});
	});

	it("normalizes blur region type and mosaic block size safely", () => {
		const editor = normalizeProjectEditor({
			annotationRegions: [
				{
					id: "annotation-1",
					startMs: 0,
					endMs: 500,
					type: "blur",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
					},
					zIndex: 1,
					blurData: {
						type: "mosaic",
						shape: "rectangle",
						color: "black",
						intensity: 999,
						blockSize: 999,
					},
				},
				{
					id: "annotation-2",
					startMs: 0,
					endMs: 500,
					type: "blur",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
					},
					zIndex: 2,
					blurData: {
						type: "invalid" as never,
						shape: "rectangle",
						color: "invalid" as never,
						intensity: 10,
						blockSize: 0,
					},
				},
			],
		});

		expect(editor.annotationRegions[0].blurData?.type).toBe("mosaic");
		expect(editor.annotationRegions[0].blurData?.color).toBe("black");
		expect(editor.annotationRegions[0].blurData?.intensity).toBe(40);
		expect(editor.annotationRegions[0].blurData?.blockSize).toBe(48);
		expect(editor.annotationRegions[1].blurData?.type).toBe("mosaic");
		expect(editor.annotationRegions[1].blurData?.color).toBe("white");
		expect(editor.annotationRegions[1].blurData?.blockSize).toBe(4);
	});

	it("accepts the dual frame webcam layout preset", () => {
		expect(normalizeProjectEditor({ webcamLayoutPreset: "dual-frame" }).webcamLayoutPreset).toBe(
			"dual-frame",
		);
	});

	it("falls back from dual frame to picture in picture for portrait aspect ratios", () => {
		expect(
			normalizeProjectEditor({
				aspectRatio: "9:16",
				webcamLayoutPreset: "dual-frame",
			}).webcamLayoutPreset,
		).toBe("picture-in-picture");
	});

	it("clears webcamPosition when the normalized preset is not picture in picture", () => {
		expect(
			normalizeProjectEditor({
				webcamLayoutPreset: "dual-frame",
				webcamPosition: { cx: 0.2, cy: 0.8 },
			}).webcamPosition,
		).toBeNull();
	});
});

it("creates stable snapshots for identical project state", () => {
	const media = {
		screenVideoPath: "/tmp/screen.webm",
		webcamVideoPath: "/tmp/webcam.webm",
	};
	const editor = normalizeProjectEditor({
		wallpaper: "/wallpapers/wallpaper1.jpg",
		shadowIntensity: 0,
		showBlur: false,
		motionBlurAmount: 0,
		borderRadius: 0,
		padding: 50,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		annotationRegions: [],
		aspectRatio: "16:9",
		webcamLayoutPreset: "picture-in-picture",
		webcamMaskShape: "circle",
		exportQuality: "good",
		exportFormat: "mp4",
		gifFrameRate: 15,
		gifLoop: true,
		gifSizePreset: "medium",
	});

	expect(createProjectSnapshot(media, editor)).toBe(createProjectSnapshot(media, editor));
});

it("detects unsaved changes from differing snapshots", () => {
	expect(hasProjectUnsavedChanges(null, null)).toBe(false);
	expect(hasProjectUnsavedChanges("same", "same")).toBe(false);
	expect(hasProjectUnsavedChanges("current", "baseline")).toBe(true);
});

describe("wallpaper legacy normalization", () => {
	it("rewrites pre-fix packaged paths (resources/assets/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/Openscreen/resources/assets/wallpapers/wallpaper5.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper5.jpg");
	});

	it("rewrites new packaged layout (resources/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/Openscreen/resources/wallpapers/wallpaper3.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper3.jpg");
	});

	it("rewrites unpackaged dev layout (public/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///home/user/project/public/wallpapers/wallpaper1.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
	});

	it("rewrites Windows-style file URLs with drive letter", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///C:/Users/me/openscreen/resources/wallpapers/wallpaper2.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper2.jpg");
	});

	it("leaves canonical relative paths untouched", () => {
		const normalized = normalizeProjectEditor({ wallpaper: "/wallpapers/wallpaper2.jpg" });
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper2.jpg");
	});

	it("leaves data URIs untouched", () => {
		const dataUri = "data:image/png;base64,AAA";
		expect(normalizeProjectEditor({ wallpaper: dataUri }).wallpaper).toBe(dataUri);
	});

	it("leaves colors and gradients untouched", () => {
		expect(normalizeProjectEditor({ wallpaper: "#1a1a2e" }).wallpaper).toBe("#1a1a2e");
		expect(
			normalizeProjectEditor({ wallpaper: "linear-gradient(90deg, red, blue)" }).wallpaper,
		).toBe("linear-gradient(90deg, red, blue)");
	});

	it("does NOT rewrite user files outside the known install layout", () => {
		const userPath = "file:///home/user/Pictures/wallpapers/wallpaper1.jpg";
		expect(normalizeProjectEditor({ wallpaper: userPath }).wallpaper).toBe(userPath);
	});

	it("falls back to default for bundled paths outside WALLPAPER_PATHS", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/Openscreen/resources/wallpapers/wallpaper99.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
	});
});

it("normalizes squircle camera rounding while preserving missing legacy values", () => {
	expect(
		normalizeProjectEditor({ webcamMaskShape: "squircle", webcamCornerRadius: 35 }),
	).toMatchObject({ webcamMaskShape: "squircle", webcamCornerRadius: 35 });
	expect(normalizeProjectEditor({}).webcamCornerRadius).toBeUndefined();
	expect(normalizeProjectEditor({ webcamCornerRadius: 100 }).webcamCornerRadius).toBe(50);
	expect(normalizeProjectEditor({ webcamCornerRadius: NaN }).webcamCornerRadius).toBeUndefined();
});

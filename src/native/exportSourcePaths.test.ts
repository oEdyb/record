import { describe, expect, it } from "vitest";
import { collectExportSourcePaths } from "./exportSourcePaths";

describe("collectExportSourcePaths", () => {
	it("collects every file-backed input once and ignores in-memory assets", () => {
		const sources = collectExportSourcePaths(
			[
				{
					screenPath: "/media/screen.mp4",
					webcamPath: "/media/camera.mov",
					cleanMicrophonePath: "/media/clean.wav",
					microphoneAudioPath: "/media/take-mic.mp4",
					systemAudioPath: "/media/take-system.mp4",
				},
			],
			JSON.stringify({
				background: { kind: "image", path: "/media/background.gif" },
				annotations: [
					{ imagePath: "/media/annotation.gif" },
					{ imagePath: "data:image/png;base64,AA==" },
				],
				videoOverlays: [{ path: "/media/broll.mp4" }],
				audioOverlays: [{ sourcePath: "/media/music.mp3" }],
				cursor: { cursorSprites: { arrow: { path: "/media/cursor.gif" } } },
			}),
			["/media/voiceover.wav", "/media/screen.mp4", "blob:preview"],
		);

		expect(sources).toEqual([
			"/media/voiceover.wav",
			"/media/screen.mp4",
			"/media/screen.mp4.cursor.json",
			"/media/camera.mov",
			"/media/clean.wav",
			"/media/take-mic.mp4",
			"/media/take-system.mp4",
			"/media/background.gif",
			"/media/annotation.gif",
			"/media/broll.mp4",
			"/media/music.mp3",
			"/media/cursor.gif",
		]);
	});

	it("rejects malformed scene metadata instead of allowing partial source coverage", () => {
		expect(() =>
			collectExportSourcePaths(
				[{ screenPath: "/media/screen.mp4" }],
				'{"audioOverlays":[{"sourcePath":"/media/voice.wav",}]}',
			),
		).toThrow("Scene metadata is invalid");
		expect(() => collectExportSourcePaths([], "[]")).toThrow("Scene metadata is invalid");
		expect(() =>
			collectExportSourcePaths([], JSON.stringify({ audioOverlays: "invalid" })),
		).toThrow("Scene metadata is invalid");
	});
});

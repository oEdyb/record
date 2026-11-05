import { expect, it, vi } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { approveCurrentProjectMedia } from "./currentProjectMedia";

it("approves every current-format video and camera through the trusted-directory gate", async () => {
	const document = createEmptyDocument({ projectId: "p", title: "Proof" });
	document.assets = [
		{
			id: "a",
			kind: "video",
			label: "Screen",
			originalPath: "/proof/screen.mp4",
			cameraTrack: { sourcePath: "/proof/camera.mp4", startMs: 0, offsetMs: 0, visible: true },
		},
		{
			id: "b",
			kind: "video",
			label: "Second",
			originalPath: "/proof/second.mp4",
			cameraTrack: null,
		},
	];
	document.project.primaryAssetId = "a";
	const approve = vi.fn(async (file: string) => file);
	const result = await approveCurrentProjectMedia(
		document,
		"/proof/edit.klippt",
		"/recordings",
		approve,
	);
	expect(approve.mock.calls.map(([file]) => file)).toEqual([
		"/proof/screen.mp4",
		"/proof/camera.mp4",
		"/proof/second.mp4",
	]);
	expect(approve).toHaveBeenCalledWith("/proof/screen.mp4", ["/recordings", "/proof"]);
	expect(result).toMatchObject({
		screenVideoPath: "/proof/screen.mp4",
		webcamVideoPath: "/proof/camera.mp4",
	});
});

it("does not bypass rejected paths or approve invalid documents", async () => {
	const document = createEmptyDocument({ projectId: "p", title: "Proof" });
	document.assets = [
		{
			id: "a",
			kind: "video",
			label: "Screen",
			originalPath: "/elsewhere/private.mp4",
			cameraTrack: null,
		},
	];
	const approve = vi.fn(async () => null);
	expect(
		await approveCurrentProjectMedia(document, "/proof/edit.klippt", "/recordings", approve),
	).toBeNull();
	approve.mockClear();
	await expect(
		approveCurrentProjectMedia(
			{ schemaVersion: 999 },
			"/proof/edit.klippt",
			"/recordings",
			approve,
		),
	).rejects.toThrow();
	expect(approve).not.toHaveBeenCalled();
	expect(
		await approveCurrentProjectMedia({ media: {} }, undefined, "/recordings", approve),
	).toBeNull();
});

it("keeps screen approval when optional audio cannot be granted", async () => {
	const document = createEmptyDocument({ projectId: "p", title: "Proof" });
	document.assets = [
		{
			id: "a",
			kind: "video",
			label: "Screen",
			originalPath: "/proof/screen.mp4",
			cameraTrack: null,
			microphoneAudioPath: "/proof/mic.mov",
			systemAudioPath: "/proof/system.mov",
		},
	];
	const approveAudio = vi.fn(async () => {
		throw new Error("Audio outside trusted folder");
	});
	const warning = vi.spyOn(console, "warn").mockReturnValue(undefined);
	try {
		const result = await approveCurrentProjectMedia(
			document,
			"/proof/edit.klippt",
			"/recordings",
			async (file) => file,
			approveAudio,
		);
		expect(result?.screenVideoPath).toBe("/proof/screen.mp4");
		expect(approveAudio).toHaveBeenCalledTimes(2);
		expect(warning).toHaveBeenCalledTimes(2);
	} finally {
		warning.mockRestore();
	}
});

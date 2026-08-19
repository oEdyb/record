import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingPrefsStore } from "./recordingPrefsStore";

const temporaryDirectories: string[] = [];

async function makeStore() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "screenrec-recording-prefs-"));
	temporaryDirectories.push(directory);
	const filePath = path.join(directory, "recording-preferences.json");
	return { filePath, store: new RecordingPrefsStore(filePath) };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("RecordingPrefsStore", () => {
	it("returns safe recording defaults when no saved preferences exist", async () => {
		const { store } = await makeStore();

		await expect(store.get()).resolves.toEqual({
			micEnabled: false,
			micDeviceId: null,
			camEnabled: false,
			camDeviceId: null,
			camFormat: { width: 1920, height: 1080, fps: 30 },
			systemAudioEnabled: false,
			cursorCaptureMode: "editable-overlay",
		});
	});

	it("restores microphone, camera, and system-audio choices after a new store instance", async () => {
		const { filePath, store } = await makeStore();

		await store.update({
			micEnabled: true,
			micDeviceId: "mic-usb",
			camEnabled: true,
			camDeviceId: "camera-studio",
			camFormat: { width: 3840, height: 2160, fps: 30 },
			systemAudioEnabled: true,
		});

		await expect(new RecordingPrefsStore(filePath).get()).resolves.toMatchObject({
			micEnabled: true,
			micDeviceId: "mic-usb",
			camEnabled: true,
			camDeviceId: "camera-studio",
			camFormat: { width: 3840, height: 2160, fps: 30 },
			systemAudioEnabled: true,
		});
	});

	it("serializes overlapping partial updates without losing either choice", async () => {
		const { filePath, store } = await makeStore();

		await Promise.all([
			store.update({ micEnabled: true, micDeviceId: "mic-a" }),
			store.update({ systemAudioEnabled: true }),
		]);

		await expect(new RecordingPrefsStore(filePath).get()).resolves.toMatchObject({
			micEnabled: true,
			micDeviceId: "mic-a",
			systemAudioEnabled: true,
		});
	});

	it("ignores malformed saved values instead of breaking recording setup", async () => {
		const { filePath } = await makeStore();
		await fs.writeFile(
			filePath,
			JSON.stringify({ micEnabled: "yes", camDeviceId: 42, cursorCaptureMode: "magic" }),
			"utf8",
		);

		await expect(new RecordingPrefsStore(filePath).get()).resolves.toMatchObject({
			micEnabled: false,
			camDeviceId: null,
			cursorCaptureMode: "editable-overlay",
		});
	});
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { matchRecordingSource, ProjectRecordingSetupStore } from "./projectRecordingSetupStore";
import { DEFAULT_RECORDING_PREFS } from "./recordingPrefsStore";

const directories: string[] = [];
const screen = { id: "screen:1:0", display_id: "1", name: "Display 1" };
const setup = {
	prefs: { ...DEFAULT_RECORDING_PREFS, micDeviceId: "usb", micEnabled: true },
	source: screen,
};

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function makeStore() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "project-recording-"));
	directories.push(directory);
	return { directory, store: new ProjectRecordingSetupStore(directory) };
}

describe("project recording setup", () => {
	it("restores separate project setups across restarts without leaking defaults", async () => {
		const { directory, store } = await makeStore();
		await store.set("project-a", setup);
		await store.set("project-b", { prefs: DEFAULT_RECORDING_PREFS, source: null });
		const restarted = new ProjectRecordingSetupStore(directory);
		expect(await restarted.get("project-a")).toEqual(setup);
		expect(await restarted.get("project-b")).toEqual({
			prefs: DEFAULT_RECORDING_PREFS,
			source: null,
		});
		expect(await restarted.get("new-project")).toBeNull();
	});

	it("serializes writes and reads the last setup without temporary files", async () => {
		const { directory, store } = await makeStore();
		const next = { ...setup, prefs: { ...setup.prefs, camEnabled: true } };
		await Promise.all([store.set("../project", setup), store.set("../project", next)]);
		expect(await store.get("../project")).toEqual(next);
		expect(await fs.readdir(directory)).toHaveLength(1);
	});

	it("reports corrupt metadata rather than silently using another setup", async () => {
		const { directory, store } = await makeStore();
		await store.set("project-a", setup);
		const [file] = await fs.readdir(directory);
		await fs.writeFile(path.join(directory, file), "{");
		await expect(store.get("project-a")).rejects.toThrow();
	});

	it("follows a stable display ID when its capture ID changes", () => {
		const moved = { ...screen, id: "screen:3:0" };
		expect(matchRecordingSource(screen, [{ ...screen, display_id: "2" }, moved])).toBe(moved);
	});

	it("requires reselection when a display disappears or a same-name window reopens", () => {
		expect(matchRecordingSource(screen, [{ ...screen, display_id: "2" }])).toBeNull();
		expect(
			matchRecordingSource({ id: "window:2:0", name: "Notes" }, [
				{ id: "window:3:0", name: "Notes" },
			]),
		).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { launchRecordingTestApp } from "./recording-test-app.mjs";

describe("packaged recording test isolation", () => {
	it("refuses to launch a package on the visible desktop", async () => {
		await expect(
			launchRecordingTestApp("/private/repo", [], {
				KLIPPT_TEST_EXECUTABLE: "/Applications/Klippt/klippt",
			}),
		).rejects.toThrow("Packaged tests require a private desktop");
	});
	it("refuses a profile outside the private test directory", async () => {
		await expect(
			launchRecordingTestApp("/private/repo", [], {
				KLIPPT_TEST_EXECUTABLE: "/Applications/Klippt/klippt",
				AGENT_LAB_RUNTIME: "/run/user/1000/agent-lab/private",
				KLIPPT_WINDOW_TEST_DIR: "/cache/private-run",
				ELECTRON_USER_DATA_DIR: "/home/user/.config/Klippt",
			}),
		).rejects.toThrow("Private profile required");
	});
});

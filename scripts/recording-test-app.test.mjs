import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchRecordingTestApp, waitForFreshDevToolsPort } from "./recording-test-app.mjs";

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

it("ignores a killed process's debugger file until the new browser endpoint is written", async () => {
	const cache = path.join(os.homedir(), ".cache", "klippt-work", "debugger-tests");
	await fs.mkdir(cache, { recursive: true });
	const directory = await fs.mkdtemp(path.join(cache, "endpoint-"));
	const file = path.join(directory, "DevToolsActivePort");
	const previous = "36493\n/devtools/browser/old-process";
	await fs.writeFile(file, previous);
	const waiting = waitForFreshDevToolsPort(file, previous, { exitCode: null, signalCode: null });
	await new Promise((resolve) => setTimeout(resolve, 150));
	await fs.writeFile(file, "41235\n/devtools/browser/new-process");
	expect(await waiting).toBe("41235");
});
it("accepts a reused port only with a fresh browser identity", async () => {
	const cache = path.join(os.homedir(), ".cache", "klippt-work", "debugger-tests");
	await fs.mkdir(cache, { recursive: true });
	const directory = await fs.mkdtemp(path.join(cache, "reused-port-"));
	const file = path.join(directory, "DevToolsActivePort");
	await fs.writeFile(file, "36493\n/devtools/browser/new-process");
	expect(
		await waitForFreshDevToolsPort(file, "36493\n/devtools/browser/old-process", {
			exitCode: null,
			signalCode: null,
		}),
	).toBe("36493");
});
it("reports an exited package rather than attaching to its previous debugger", async () => {
	await expect(
		waitForFreshDevToolsPort("/private/missing", "36493\n/devtools/browser/old-process", {
			exitCode: 1,
			signalCode: null,
		}),
	).rejects.toThrow("Packaged app exited 1");
});

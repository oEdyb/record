import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ParakeetHelperManager } from "./parakeetHelper";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

function helperProcess() {
	const child = new EventEmitter() as EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		stderr: PassThrough;
		exitCode: number | null;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.kill = vi.fn();
	return child;
}

describe("ParakeetHelperManager", () => {
	it("cancels and kills a helper that is auto-respawning for a request", async () => {
		const first = helperProcess();
		const respawn = helperProcess();
		spawnMock.mockReset().mockReturnValueOnce(first).mockReturnValueOnce(respawn);
		const manager = new ParakeetHelperManager();
		const initialStart = manager.start({ modelDir: "/models", binaryPath: "/helper" });
		first.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
		await initialStart;

		first.exitCode = 1;
		first.emit("exit", 1, null);
		const controller = new AbortController();
		const run = manager.transcribe({ samples: new Float32Array(16), signal: controller.signal });
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
		controller.abort();

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(respawn.kill).toHaveBeenCalledWith("SIGKILL");
	});
});

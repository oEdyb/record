import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { NativeMacStandbyHelper, STANDBY_HELPER_MAX_AGE_MS } from "./nativeMacStandbyHelper";

function fakeProcess() {
	const process = Object.assign(new EventEmitter(), {
		exitCode: null as number | null,
		signalCode: null as string | null,
		stdin: { destroyed: false, write: vi.fn() },
		kill: vi.fn(),
	});
	return process;
}

function setup() {
	let now = 1_000;
	const spawned: ReturnType<typeof fakeProcess>[] = [];
	const helper = new NativeMacStandbyHelper({
		spawn: () => {
			const process = fakeProcess();
			spawned.push(process);
			return process as unknown as ChildProcessWithoutNullStreams;
		},
		now: () => now,
	});
	return { helper, spawned, advance: (ms: number) => (now += ms) };
}

describe("NativeMacStandbyHelper", () => {
	it("spawns one warm helper and hands it the request on Record", () => {
		const { helper, spawned } = setup();
		helper.warm("/helper");
		helper.warm("/helper");
		expect(spawned).toHaveLength(1);

		const process = helper.take("/helper", { recordingId: 7 });

		expect(process).toBe(spawned[0]);
		expect(spawned[0].stdin.write).toHaveBeenCalledWith('{"recordingId":7}\n');
		expect(helper.take("/helper", {})).toBeNull();
	});

	it("tells the standby helper which camera to keep started, and when to release it", () => {
		const { helper, spawned } = setup();
		const camera = {
			webcam: { enabled: true, width: 1920, height: 1080, fps: 30 },
			quality: "high",
		};
		helper.warm("/helper");
		helper.setWarmCamera(camera);
		helper.setWarmCamera(camera);
		expect(spawned[0].stdin.write.mock.calls).toEqual([
			[`${JSON.stringify({ warmCamera: camera })}\n`],
		]);

		helper.setWarmCamera(null);
		expect(spawned[0].stdin.write).toHaveBeenLastCalledWith('{"warmCamera":null}\n');

		// A helper spawned later learns the camera that is being shown right now.
		helper.setWarmCamera(camera);
		helper.discard();
		helper.warm("/helper");
		expect(spawned[1].stdin.write.mock.calls).toEqual([
			[`${JSON.stringify({ warmCamera: camera })}\n`],
		]);
	});

	it("never hands over a helper that exited or is close to its idle exit", () => {
		const { helper, spawned, advance } = setup();
		helper.warm("/helper");
		spawned[0].exitCode = 0;
		spawned[0].emit("close", 0);
		expect(helper.take("/helper", {})).toBeNull();

		helper.warm("/helper");
		advance(STANDBY_HELPER_MAX_AGE_MS);
		expect(helper.take("/helper", {})).toBeNull();
		expect(spawned[1].kill).toHaveBeenCalled();
		expect(spawned[1].stdin.write).not.toHaveBeenCalled();
	});

	it("replaces a stale helper when warmed again", () => {
		const { helper, spawned, advance } = setup();
		helper.warm("/helper");
		advance(STANDBY_HELPER_MAX_AGE_MS);
		helper.warm("/helper");
		expect(spawned).toHaveLength(2);
		expect(spawned[0].kill).toHaveBeenCalled();
		expect(helper.take("/helper", {})).toBe(spawned[1]);
	});
});

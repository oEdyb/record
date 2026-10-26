import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { NativeRecordingAppStopRequest } from "../../src/lib/nativeMacRecording";
import { RendererRecordingStop } from "./rendererRecordingStop";

function renderer() {
	return Object.assign(new EventEmitter(), {
		isDestroyed: vi.fn(() => false),
		send: vi.fn<(channel: string, request: NativeRecordingAppStopRequest) => void>(),
	});
}

describe("renderer recording Stop acknowledgement", () => {
	it("waits for the owning HUD and rejects other windows, takes, tokens and replay", async () => {
		const owner = renderer();
		const other = renderer();
		const handoff = new RendererRecordingStop();
		handoff.bind(owner, 7);
		let complete = false;
		const pending = handoff.wait(7, new AbortController().signal).then(() => {
			complete = true;
		});
		const request = owner.send.mock.calls[0]?.[1];
		if (!request) throw new Error("App Stop request was not sent");
		expect(handoff.acknowledge(other, { ...request, success: true })).toBe(false);
		expect(handoff.acknowledge(owner, { ...request, recordingId: 8, success: true })).toBe(false);
		expect(handoff.acknowledge(owner, { ...request, token: "old-generation", success: true })).toBe(
			false,
		);
		await Promise.resolve();
		expect(complete).toBe(false);
		expect(handoff.acknowledge(owner, { ...request, success: true })).toBe(true);
		await pending;
		expect(complete).toBe(true);
		expect(owner.listenerCount("destroyed")).toBe(0);
		expect(handoff.acknowledge(owner, { ...request, success: true })).toBe(false);
	});

	it("tracks an ordinary take until save completion, even before a quit waiter exists", async () => {
		const owner = renderer();
		const handoff = new RendererRecordingStop();
		const request = handoff.bind(owner, 7);
		expect(handoff.pendingRecordingId()).toBe(7);
		expect(handoff.acknowledge(renderer(), { ...request, success: true })).toBe(false);
		expect(handoff.pendingRecordingId()).toBe(7);
		expect(handoff.acknowledge(owner, { ...request, success: true })).toBe(true);
		expect(handoff.pendingRecordingId()).toBeNull();
		await expect(handoff.wait(7, new AbortController().signal)).resolves.toBeUndefined();
		expect(owner.send).not.toHaveBeenCalled();
	});

	it("rejects renderer errors and removes pending listeners", async () => {
		const owner = renderer();
		const handoff = new RendererRecordingStop();
		handoff.bind(owner, 7);
		const pending = handoff.wait(7, new AbortController().signal);
		const failure = expect(pending).rejects.toThrow("Camera attachment failed");
		handoff.acknowledge(owner, {
			...owner.send.mock.calls[0]?.[1],
			success: false,
			error: "Camera attachment failed",
		});
		await failure;
		expect(owner.listenerCount("destroyed")).toBe(0);
	});

	it("fails loudly if the HUD closes", async () => {
		const owner = renderer();
		const handoff = new RendererRecordingStop();
		handoff.bind(owner, 7);
		const pending = handoff.wait(7, new AbortController().signal);
		const failure = expect(pending).rejects.toThrow("HUD closed");
		owner.emit("destroyed");
		await failure;
	});

	it("cleans up on the shared quit deadline and rejects a late acknowledgement", async () => {
		const owner = renderer();
		const handoff = new RendererRecordingStop();
		const deadline = new AbortController();
		handoff.bind(owner, 7);
		const pending = handoff.wait(7, deadline.signal);
		const failure = expect(pending).rejects.toThrow("deadline expired");
		deadline.abort();
		await failure;
		expect(owner.listenerCount("destroyed")).toBe(0);
		expect(handoff.acknowledge(owner, { ...owner.send.mock.calls[0]?.[1], success: true })).toBe(
			false,
		);
	});

	it("uses a fresh token even when a later take reuses the recording id", async () => {
		const owner = renderer();
		const handoff = new RendererRecordingStop();
		handoff.bind(owner, 7);
		const first = handoff.wait(7, new AbortController().signal);
		const oldRequest = owner.send.mock.calls[0]?.[1];
		handoff.acknowledge(owner, { ...oldRequest, success: true });
		await first;
		handoff.bind(owner, 7);
		const second = handoff.wait(7, new AbortController().signal);
		expect(handoff.acknowledge(owner, { ...oldRequest, success: true })).toBe(false);
		handoff.acknowledge(owner, { ...owner.send.mock.calls[1]?.[1], success: true });
		await second;
	});
});

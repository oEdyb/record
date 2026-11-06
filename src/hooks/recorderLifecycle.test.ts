import { describe, expect, it, vi } from "vitest";
import { RecorderLifecycle, recorderPresentation } from "./recorderLifecycle";

function live() {
	const machine = new RecorderLifecycle();
	expect(machine.transition({ type: "start" })).toBe(true);
	expect(machine.transition({ type: "started", takeId: 7 })).toBe(true);
	return machine;
}

describe("recorder lifecycle", () => {
	it("rejects and logs a second start without replacing live footage ownership", () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const machine = live();
			expect(machine.transition({ type: "start" })).toBe(false);
			expect(machine.getSnapshot()).toEqual({ kind: "recording", takeId: 7 });
			expect(log).toHaveBeenCalledWith("[recorder-lifecycle] Illegal transition", {
				state: "recording",
				event: "start",
			});
		} finally {
			log.mockRestore();
		}
	});
	it.each([
		"pause",
		"resume",
	] as const)("queues Stop until the pending %s acknowledgement", async (operation) => {
		const machine = live();
		if (operation === "resume") {
			machine.transition({ type: "pause" });
			machine.transition({ type: "paused", takeId: 7 });
		}
		machine.transition({ type: operation });
		if (operation === "resume") machine.transition({ type: "resume-dispatched" });
		let settled = false;
		const completion = machine.transport()?.then(() => {
			settled = true;
		});
		expect(machine.transition({ type: "request-stop", intent: "save" })).toBe(true);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(machine.getSnapshot()).toMatchObject({ kind: "stop-queued", takeId: 7, intent: "save" });
		machine.transition({ type: operation === "pause" ? "paused" : "resumed", takeId: 7 });
		await completion;
		expect(settled).toBe(true);
		expect(machine.transition({ type: "begin-stop", takeId: 7, intent: "save" })).toBe(true);
		machine.transition({ type: "writer-released", takeId: 7 });
		expect(recorderPresentation(machine.getSnapshot())).toMatchObject({
			recording: false,
			saving: true,
		});
		machine.transition({ type: "saved", takeId: 7 });
		expect(machine.getSnapshot()).toEqual({ kind: "idle" });
	});
	it("lets Save override a queued Restart without discarding the take", () => {
		const machine = live();
		machine.transition({ type: "pause" });
		machine.transition({ type: "request-stop", intent: "restart" });
		machine.transition({ type: "request-stop", intent: "save" });
		machine.transition({ type: "request-stop", intent: "discard" });
		machine.transition({ type: "paused", takeId: 7 });
		machine.transition({ type: "begin-stop", takeId: 7, intent: "discard" });
		expect(machine.intent()).toBe("save");
		machine.transition({ type: "saved", takeId: 7 });
		expect(machine.getSnapshot()).toEqual({ kind: "idle" });
	});
	it("cancels an unissued Continue when Stop arrives during camera setup", () => {
		const machine = live();
		machine.transition({ type: "pause" });
		machine.transition({ type: "paused", takeId: 7 });
		machine.transition({ type: "resume" });
		expect(recorderPresentation(machine.getSnapshot()).recording).toBe(true);
		expect(machine.transport()).toBeNull();
		machine.transition({ type: "request-stop", intent: "save" });
		machine.transition({ type: "begin-stop", takeId: 7, intent: "save" });
		expect(machine.isFinalizing(7)).toBe(true);
	});
	it("retains Stop after a failed Continue acknowledgement", async () => {
		const machine = live();
		machine.transition({ type: "pause" });
		machine.transition({ type: "paused", takeId: 7 });
		machine.transition({ type: "resume" });
		machine.transition({ type: "resume-dispatched" });
		const completion = machine.transport();
		machine.transition({ type: "request-stop", intent: "save" });
		machine.transition({ type: "transport-failed", takeId: 7, paused: true });
		await completion;
		expect(machine.getSnapshot()).toEqual({
			kind: "stop-requested",
			takeId: 7,
			previous: "paused",
			intent: "save",
		});
	});
});

it("holds start ownership through cancellation until the old start has cleaned up", () => {
	const machine = new RecorderLifecycle();
	machine.transition({ type: "start" });
	machine.transition({ type: "cancel-start" });
	expect(machine.starting).toBe(true);
	expect(machine.transition({ type: "start" })).toBe(false);
	expect(machine.transition({ type: "started", takeId: 7 })).toBe(false);
	machine.transition({ type: "start-settled" });
	expect(machine.transition({ type: "start" })).toBe(true);
	expect(machine.transition({ type: "started", takeId: 8 })).toBe(true);
	expect(machine.getSnapshot()).toEqual({ kind: "recording", takeId: 8 });
});
it("joins finalization before starting the replacement take", async () => {
	const machine = live();
	machine.transition({ type: "request-stop", intent: "discard" });
	machine.transition({ type: "begin-stop", takeId: 7, intent: "discard" });
	const saved = machine.waitUntilSaved(7);
	machine.transition({ type: "request-stop", intent: "restart" });
	machine.transition({ type: "saved", takeId: 7 });
	await saved;
	expect(machine.getSnapshot()).toEqual({ kind: "restarting" });
	expect(machine.transition({ type: "start" })).toBe(true);
	expect(machine.getSnapshot()).toEqual({ kind: "starting", origin: "restart" });
});

import { describe, expect, it, vi } from "vitest";
import {
	type AgentTransportHandlers,
	getAgentTransport,
	registerAgentTransport,
	runAgentTransport,
} from "./agentTransport";

function fakeTransport() {
	let time = 10;
	let playing = false;
	const calls: string[] = [];
	const handlers: AgentTransportHandlers = {
		seek: (sec) => {
			calls.push(`seek:${sec}`);
			time = sec;
		},
		click: (testId, fraction) => {
			calls.push(`click:${testId}@${fraction}`);
		},
		wheel: (testId, fraction, deltaX, deltaY, ctrl) => {
			calls.push(`wheel:${testId}@${fraction}:${deltaX},${deltaY},${ctrl}`);
		},
		frame: () => "data:image/jpeg;base64,x",
		play: () => {
			calls.push("play");
			playing = true;
		},
		pause: () => {
			calls.push("pause");
			playing = false;
		},
		snapshot: () => ({
			currentTimeSec: time,
			playing,
			videoTimeSec: time,
			videoPaused: !playing,
		}),
	};
	return { handlers, calls };
}

describe("agent transport", () => {
	it("registers the editor's handlers and unregisters only its own", () => {
		const first = fakeTransport().handlers;
		const second = fakeTransport().handlers;
		const disposeFirst = registerAgentTransport(first);
		registerAgentTransport(second);
		disposeFirst();
		expect(getAgentTransport()).toBe(second);
	});

	it("runs the steps in order and samples the transport after each sample step", async () => {
		vi.useFakeTimers();
		const { handlers, calls } = fakeTransport();
		const probe = { start: vi.fn(), stop: vi.fn(), report: vi.fn(() => ({ ok: true })) };
		const run = runAgentTransport(
			[
				{ op: "play" },
				{ op: "wait", ms: 100 },
				{ op: "seek", sec: 42 },
				{ op: "click", testId: "timeline-ruler", fraction: 0.25 },
				{ op: "wheel", testId: "timeline-tracks", fraction: 0.5, deltaY: -100, ctrl: true },
				{ op: "sample", label: "after-seek", frame: true },
				{ op: "probe", ms: 200 },
				{ op: "pause" },
			],
			handlers,
			probe,
		);
		await vi.advanceTimersByTimeAsync(400);
		const result = await run;
		vi.useRealTimers();
		expect(calls).toEqual([
			"play",
			"seek:42",
			"click:timeline-ruler@0.25",
			"wheel:timeline-tracks@0.5:0,-100,true",
			"pause",
		]);
		expect(result.samples[0].frame).toBe("data:image/jpeg;base64,x");
		expect(result.samples[1].frame).toBeUndefined();
		expect(result.samples.map((s) => [s.label, s.currentTimeSec, s.playing])).toEqual([
			["after-seek", 42, true],
			["end", 42, false],
		]);
		expect(probe.start).toHaveBeenCalledTimes(1);
		expect(probe.stop).toHaveBeenCalledTimes(1);
		expect(result.probe).toEqual({ ok: true });
	});

	it("refuses a run that would wait longer than a minute", async () => {
		const { handlers } = fakeTransport();
		await expect(runAgentTransport([{ op: "wait", ms: 61_000 }], handlers)).rejects.toThrow(
			"TRANSPORT_TOO_LONG",
		);
	});

	it("waits for the settled frame before capturing a frame sample", async () => {
		const { handlers } = fakeTransport();
		const order: string[] = [];
		handlers.awaitFrameSettled = async () => {
			order.push("settled");
			return true;
		};
		const nativeFrame = {
			timeBase: "source" as const,
			viewId: 7,
			clipIndex: 2,
			sourceTimeSec: 8.25,
			generation: 4,
		};
		handlers.frameEvidence = () => nativeFrame;
		const frame = handlers.frame;
		handlers.frame = () => {
			order.push("frame");
			return frame();
		};
		const result = await runAgentTransport(
			[
				{ op: "seek", sec: 42 },
				{ op: "sample", label: "proof", frame: true },
			],
			handlers,
		);
		expect(order).toEqual(["settled", "frame"]);
		expect(result.samples[0].nativeFrame).toEqual(nativeFrame);
		expect(result.samples[0].frameSettled).toBe(true);
		expect(result.samples[0].frame).toBe("data:image/jpeg;base64,x");
	});

	it("marks the sample unsettled when the frame never settles within the budget", async () => {
		const { handlers } = fakeTransport();
		handlers.awaitFrameSettled = async () => false;
		const result = await runAgentTransport(
			[
				{ op: "seek", sec: 42 },
				{ op: "sample", label: "proof", frame: true },
			],
			handlers,
		);
		expect(result.samples[0].frameSettled).toBe(false);
		expect(result.samples[0].frame).toBe("data:image/jpeg;base64,x");
	});

	it("captures frame samples without a settle flag when the shell predates the handshake", async () => {
		const { handlers } = fakeTransport();
		const result = await runAgentTransport(
			[
				{ op: "seek", sec: 42 },
				{ op: "sample", label: "proof", frame: true },
			],
			handlers,
		);
		expect(result.samples[0].frame).toBe("data:image/jpeg;base64,x");
		expect("frameSettled" in result.samples[0]).toBe(false);
	});
});

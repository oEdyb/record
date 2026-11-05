import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordRequest } from "./recordRequest";
import { recordRequestTrace } from "./recordRequestTrace";

describe("Record delivery and writer acknowledgement", () => {
	afterEach(() => vi.useRealTimers());
	function setup() {
		const renderer = {};
		const state = {
			owner: null as object | null,
			recordingId: null as number | null,
			running: false,
		};
		const send = vi.fn();
		const ensure = vi.fn();
		const request = new RecordRequest({
			owner: () => state.owner,
			ensure,
			send,
			take: () => state,
		});
		return { renderer, state, send, ensure, request };
	}
	it("recreates the missing owner and waits for subscription before sending once", async () => {
		const { renderer, state, send, ensure, request } = setup();
		const result = request.start();
		expect(ensure).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		state.owner = renderer;
		request.ready(renderer, true);
		expect(send).toHaveBeenCalledOnce();
		const token = send.mock.calls[0][0];
		request.ready(renderer, false);
		request.ready(renderer, true);
		expect(send).toHaveBeenCalledOnce();
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		state.running = true;
		state.recordingId = 7;
		await Promise.resolve();
		expect(settled).toBe(false);
		request.progress({}, token, "writer-started", { recordingId: 7 });
		request.progress(renderer, token - 1, "writer-started", { recordingId: 7 });
		await Promise.resolve();
		expect(settled).toBe(false);
		request.progress(renderer, token, "writer-started", { recordingId: 7 });
		expect(await result).toEqual({ success: true, recordingId: 7 });
	});
	it("reports a busy renderer instead of accepting a dropped press", async () => {
		const { renderer, state, send, request } = setup();
		state.owner = renderer;
		request.ready(renderer, true);
		const result = request.start();
		request.progress(renderer, send.mock.calls[0][0], "renderer-guard", { saving: true });
		expect(await result).toMatchObject({ success: false, error: expect.stringMatching(/busy/i) });
	});
	it("times out with its last stage and never retries a toggle", async () => {
		vi.useFakeTimers();
		const { renderer, state, send, request } = setup();
		state.owner = renderer;
		request.ready(renderer, true);
		const result = request.start();
		const duplicate = await request.start();
		expect(duplicate.success).toBe(false);
		request.progress(renderer, send.mock.calls[0][0], "source-read", {});
		await vi.advanceTimersByTimeAsync(30000);
		expect(await result).toMatchObject({
			success: false,
			error: expect.stringContaining("not confirmed"),
		});
		expect(send).toHaveBeenCalledOnce();
		expect(recordRequestTrace.read().at(-1)?.stage).toBe("timeout:source-read");
	});
});

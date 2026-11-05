// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { receiveRecordRequest, traceRecordRequest } from "./recordRequestTrace";

afterEach(() => traceRecordRequest("cleanup", { captureStarted: false }));
describe("renderer Record tokens", () => {
	it("does not let a tokenless tray press replace a pending request", () => {
		const trace = vi.fn();
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { traceRecordRequest: trace },
		});
		expect(receiveRecordRequest(71)).toBe(true);
		expect(receiveRecordRequest(undefined)).toBe(false);
		traceRecordRequest("source-read");
		expect(trace).toHaveBeenLastCalledWith({ token: 71, stage: "source-read", flags: {} });
		traceRecordRequest("writer-started", { recordingId: 8 });
		const count = trace.mock.calls.length;
		traceRecordRequest("click");
		expect(trace).toHaveBeenCalledTimes(count);
		expect(receiveRecordRequest(undefined)).toBe(true);
	});
});

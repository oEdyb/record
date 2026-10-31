import { afterEach, describe, expect, it, vi } from "vitest";
import { checkVoiceoverDuration, readBoundedVoiceoverInput } from "./voiceoverLimits";

afterEach(() => vi.unstubAllGlobals());
describe("bounded voiceover input", () => {
	it("reads a small body without whole-response buffering", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
		);
		expect((await readBoundedVoiceoverInput("file:///take.mp4", 3)).size).toBe(3);
	});
	it.each([
		undefined,
		"1",
		"100",
	])("rejects an oversized body with content-length %s", async (length) => {
		const cancelled = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(4));
							},
							cancel: cancelled,
						}),
						{ headers: length ? { "content-length": length } : {} },
					),
			),
		);
		await expect(readBoundedVoiceoverInput("file:///take.mp4", 3)).rejects.toThrow("memory limit");
		expect(cancelled).toHaveBeenCalledOnce();
	});
	it.each([
		NaN,
		Infinity,
		0,
		-1,
		301,
	])("rejects unbounded decoded audio duration %s", (duration) => {
		expect(() => checkVoiceoverDuration(duration)).toThrow("5 minutes");
	});
	it("allows the duration boundary", () => expect(() => checkVoiceoverDuration(300)).not.toThrow());
});

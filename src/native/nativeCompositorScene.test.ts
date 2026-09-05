import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCompositorScene } from "./compositorViewClient";
import { setCurrentNativeViewId, setNativeScene } from "./nativeCompositorStore";

vi.mock("./compositorViewClient", () => ({
	setCompositorScene: vi.fn(async () => undefined),
	setCompositorParam: vi.fn(async () => undefined),
}));

beforeEach(() => {
	setCurrentNativeViewId(null);
	vi.mocked(setCompositorScene).mockReset().mockResolvedValue({ ok: true });
});

describe("native scene submissions", () => {
	it("deduplicates exact scenes while preserving changed scenes and view recreation", () => {
		setNativeScene("one");
		expect(setCompositorScene).not.toHaveBeenCalled();
		setCurrentNativeViewId(1);
		setNativeScene("one");
		setNativeScene("one");
		setNativeScene("two");
		setNativeScene("one");
		setCurrentNativeViewId(null);
		setCurrentNativeViewId(1);
		setNativeScene("one");
		expect(vi.mocked(setCompositorScene).mock.calls).toEqual([
			[1, "one"],
			[1, "two"],
			[1, "one"],
			[1, "one"],
		]);
	});

	it("retries a failed scene but does not let an older failure invalidate a newer submission", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let failOlder: ((error: Error) => void) | undefined;
		vi.mocked(setCompositorScene).mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					failOlder = reject;
				}),
		);
		setCurrentNativeViewId(2);
		setNativeScene("older");
		setNativeScene("newer");
		failOlder?.(new Error("old failure"));
		await Promise.resolve();
		setNativeScene("newer");
		expect(setCompositorScene).toHaveBeenCalledTimes(2);
		vi.mocked(setCompositorScene).mockRejectedValueOnce(new Error("retryable"));
		setNativeScene("retry");
		await Promise.resolve();
		setNativeScene("retry");
		expect(setCompositorScene).toHaveBeenCalledTimes(4);
		vi.restoreAllMocks();
	});
});

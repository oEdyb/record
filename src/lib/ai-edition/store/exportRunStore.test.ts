import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportRunPercent, isExportRunActive, useExportRunStore } from "./exportRunStore";

const progress = (percentage: number) => ({
	currentFrame: 1,
	totalFrames: 100,
	percentage,
	estimatedTimeRemaining: 10,
});

describe("exportRunStore", () => {
	beforeEach(() => {
		useExportRunStore.setState({ phase: "idle", cancel: null, progress: null, error: null });
	});

	it("keeps the running export when reset is requested and cancels through the stored handle", () => {
		const cancel = vi.fn();
		const store = useExportRunStore.getState();
		store.begin(cancel);
		store.setPhase("rendering");
		store.setProgress(progress(42));
		useExportRunStore.getState().reset();
		expect(useExportRunStore.getState().phase).toBe("rendering");
		expect(exportRunPercent(useExportRunStore.getState())).toBe(42);
		useExportRunStore.getState().requestCancel();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("clears the cancel handle and returns to idle after success", () => {
		const store = useExportRunStore.getState();
		store.begin(() => undefined);
		store.setPhase("writing");
		expect(exportRunPercent(useExportRunStore.getState())).toBe(100);
		useExportRunStore.getState().succeed({ savedPath: "/tmp/out.mp4", audioMastering: null });
		const done = useExportRunStore.getState();
		expect(done.phase).toBe("done");
		expect(done.cancel).toBeNull();
		expect(isExportRunActive(done.phase)).toBe(false);
		done.reset();
		expect(useExportRunStore.getState().phase).toBe("idle");
		expect(useExportRunStore.getState().savedPath).toBeNull();
	});

	it("reports no percent before the first encoded frame and keeps failure details", () => {
		const store = useExportRunStore.getState();
		store.begin(() => undefined);
		store.setPhase("rendering");
		expect(exportRunPercent(useExportRunStore.getState())).toBeNull();
		useExportRunStore.getState().fail("disk full", { code: "ENOSPC", retryable: true });
		const failed = useExportRunStore.getState();
		expect(failed.phase).toBe("error");
		expect(failed.errorDetails?.code).toBe("ENOSPC");
		expect(failed.cancel).toBeNull();
	});
});

import { describe, expect, it, vi } from "vitest";
import { RecordingWakeLock } from "./recordingWakeLock";

function setup(platform = "linux") {
	let next = 7;
	const blocker = {
		start: vi.fn(() => next++),
		stop: vi.fn(),
	};
	const onError = vi.fn();
	return { blocker, onError, lock: new RecordingWakeLock(platform, blocker, onError) };
}

describe("RecordingWakeLock", () => {
	it("holds a display-sleep inhibitor from recording start until stop on Linux", () => {
		const { lock, blocker } = setup("linux");
		lock.set(true);
		expect(blocker.start).toHaveBeenCalledWith("prevent-display-sleep");
		expect(lock.held).toBe(true);
		lock.set(false);
		expect(blocker.stop).toHaveBeenCalledWith(7);
		expect(lock.held).toBe(false);
	});

	it("is idempotent across repeated start and stop notifications", () => {
		const { lock, blocker } = setup("linux");
		lock.set(true);
		lock.set(true);
		expect(blocker.start).toHaveBeenCalledTimes(1);
		lock.set(false);
		lock.set(false);
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		lock.set(true);
		expect(blocker.start).toHaveBeenCalledTimes(2);
		expect(lock.held).toBe(true);
	});

	it("releasing without ever acquiring does nothing", () => {
		const { lock, blocker } = setup("linux");
		lock.set(false);
		expect(blocker.stop).not.toHaveBeenCalled();
	});

	it.each([
		"darwin",
		"win32",
	])("leaves %s alone (macOS holds its own activity in the helper)", (platform) => {
		const { lock, blocker } = setup(platform);
		lock.set(true);
		lock.set(false);
		expect(blocker.start).not.toHaveBeenCalled();
		expect(blocker.stop).not.toHaveBeenCalled();
		expect(lock.held).toBe(false);
	});

	it("reports an unavailable inhibit service without failing the take", () => {
		const { lock, blocker, onError } = setup("linux");
		const failure = new Error("no screensaver service");
		blocker.start.mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => lock.set(true)).not.toThrow();
		expect(onError).toHaveBeenCalledWith(failure);
		expect(lock.held).toBe(false);
		// A later start can still acquire it.
		lock.set(true);
		expect(lock.held).toBe(true);
	});

	it("forgets the inhibitor even when stopping it throws", () => {
		const { lock, blocker, onError } = setup("linux");
		lock.set(true);
		const failure = new Error("gone");
		blocker.stop.mockImplementationOnce(() => {
			throw failure;
		});
		expect(() => lock.set(false)).not.toThrow();
		expect(onError).toHaveBeenCalledWith(failure);
		expect(lock.held).toBe(false);
	});
});

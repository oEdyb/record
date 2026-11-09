import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinuxRecordingHud } from "./linuxRecordingHud";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	let capturing = false;
	let visible = true;
	const calls: string[] = [];
	const proof = deferred<boolean>();
	const window = {
		isDestroyed: () => false,
		isVisible: () => visible,
		hide: vi.fn(() => {
			visible = false;
			calls.push("hide");
		}),
		show: vi.fn(() => {
			visible = true;
			calls.push("show");
		}),
		focus: vi.fn(),
		webContents: { send: vi.fn((channel: string) => calls.push(channel)) },
	};
	const hud = new LinuxRecordingHud(
		"linux",
		() => window,
		() => capturing,
		() => true,
		async () => {
			calls.push("unmap");
		},
		undefined,
		async (hidden) => {
			calls.push(`preview:${hidden}`);
		},
		{
			begin: () => proof.promise,
			end: () => {
				calls.push("isolation:end");
			},
		},
	);
	const record = vi.fn(async () => {
		capturing = true;
		calls.push("record");
		return { success: true };
	});
	return {
		hud,
		window,
		calls,
		proof,
		record,
		setCapturing: (value: boolean) => {
			capturing = value;
		},
	};
}

describe("recording HUD ownership overlaps", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("keeps a pre-proof revocation after a second notification sees the hidden HUD", async () => {
		const { hud, window, calls, proof, record } = fixture();
		const pending = hud.capture(record);
		hud.revoke();
		hud.revoke();
		proof.resolve(true);
		await pending;
		await vi.advanceTimersByTimeAsync(1000);
		const recovered = hud.requestControls();
		console.log("double-revocation", JSON.stringify({ calls, recovered }));
		expect(window.show).not.toHaveBeenCalled();
		expect(record).toHaveBeenCalledOnce();
		expect(recovered).toBe(true);
		expect(window.webContents.send).not.toHaveBeenCalled();
	});

	it("keeps deliberate dismissal concealed after an outstanding retained proof", async () => {
		const { hud, window, calls, proof, record } = fixture();
		const pending = hud.capture(record);
		window.hide();
		hud.dismiss();
		proof.resolve(true);
		await pending;
		expect(window.webContents.send).not.toHaveBeenCalled();
		const recovered = hud.requestControls();
		console.log("dismiss-during-proof", JSON.stringify({ calls, recovered }));
		expect(recovered).toBe(true);
		expect(window.webContents.send).not.toHaveBeenCalled();
	});

	it("keeps explicit concealment after an outstanding retained proof", async () => {
		const { hud, calls, proof, record } = fixture();
		const pending = hud.capture(record);
		hud.conceal();
		proof.resolve(true);
		await pending;
		const recovered = hud.requestControls();
		console.log("conceal-during-proof", JSON.stringify({ calls, recovered }));
		expect(recovered).toBe(true);
	});

	it("honors a new controls request while a cancelled admitted writer settles", async () => {
		const { hud, calls, proof, setCapturing, window } = fixture();
		const admitted = deferred<void>();
		const settled = deferred<{ success: boolean }>();
		const pending = hud.capture(async () => {
			setCapturing(true);
			calls.push("record");
			admitted.resolve();
			return settled.promise;
		});
		proof.resolve(false);
		await admitted.promise;
		hud.cancelPending();
		const recovered = hud.requestControls();
		settled.resolve({ success: true });
		await pending;
		await vi.advanceTimersByTimeAsync(500);
		console.log("recover-cancelled-writer", JSON.stringify({ calls, recovered }));
		expect(window.show).not.toHaveBeenCalled();
		expect(recovered).toBe(true);
		expect(window.webContents.send).not.toHaveBeenCalled();
	});

	it("retains a revocation received while a cancelled admitted writer settles", async () => {
		const { hud, calls, proof, setCapturing, window } = fixture();
		const admitted = deferred<void>();
		const settled = deferred<{ success: boolean }>();
		const pending = hud.capture(async () => {
			setCapturing(true);
			calls.push("record");
			admitted.resolve();
			return settled.promise;
		});
		proof.resolve(true);
		await admitted.promise;
		hud.cancelPending();
		hud.revoke();
		settled.resolve({ success: true });
		await pending;
		await vi.advanceTimersByTimeAsync(500);
		console.log("revoke-cancelled-writer", JSON.stringify({ calls }));
		expect(window.show).not.toHaveBeenCalled();
		expect(window.webContents.send).not.toHaveBeenCalled();
	});

	it("does not let the old proof finish or restore over its replacement", async () => {
		const { hud, calls, proof, window } = fixture();
		const oldWriter = vi.fn(async () => ({ success: true }));
		const first = hud.capture(oldWriter);
		const rejected = expect(first).rejects.toThrow("Recording start cancelled");
		hud.cancelPending();
		const replacementWriter = vi.fn(async () => ({ success: false }));
		const second = hud.capture(replacementWriter);
		proof.resolve(true);
		await rejected;
		await second;
		console.log("replacement-proof", JSON.stringify({ calls }));
		expect(oldWriter).not.toHaveBeenCalled();
		expect(replacementWriter).toHaveBeenCalledOnce();
		expect(window.show).toHaveBeenCalledOnce();
	});
});

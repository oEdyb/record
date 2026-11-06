import { describe, expect, it, vi } from "vitest";
import { StudioCommandStateStore } from "./studioCommandState";

describe("Studio command lifecycle", () => {
	it("rejects a second command without replacing the pending command", () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const store = new StudioCommandStateStore();
			const token = Symbol();
			expect(store.transition({ type: "send", command: "resume", token })).toBe(true);
			expect(store.transition({ type: "send", command: "stop", token: Symbol() })).toBe(false);
			expect(store.getSnapshot()).toEqual({ kind: "pending", command: "resume", token });
			expect(log).toHaveBeenCalledWith("[studio-command] Illegal transition", {
				state: "pending",
				event: "send",
			});
		} finally {
			log.mockRestore();
		}
	});
	it("rejects a late completion instead of unlocking a newer command", () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const store = new StudioCommandStateStore();
			const old = Symbol();
			store.transition({ type: "send", command: "resume", token: old });
			store.transition({ type: "snapshot" });
			const token = Symbol();
			store.transition({ type: "send", command: "pause", token });
			expect(store.transition({ type: "settle", token: old })).toBe(false);
			expect(store.getSnapshot()).toEqual({ kind: "pending", command: "pause", token });
			expect(log).toHaveBeenCalledOnce();
			store.transition({ type: "settle", token });
			expect(store.getSnapshot()).toEqual({ kind: "idle" });
		} finally {
			log.mockRestore();
		}
	});
});

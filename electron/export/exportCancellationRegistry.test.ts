import { expect, it, vi } from "vitest";
import { ExportCancellationRegistry } from "./exportCancellationRegistry";

it("rejects a duplicate export identity and keeps cancellation with its original owner", () => {
	const registry = new ExportCancellationRegistry();
	const first = new AbortController();
	const second = new AbortController();
	expect(registry.transition({ type: "register", id: "take", controller: first, at: 0 })).toBe(
		true,
	);
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		expect(registry.transition({ type: "register", id: "take", controller: second, at: 1 })).toBe(
			false,
		);
		expect(log).toHaveBeenCalledWith("[export-cancellation] Illegal transition", {
			state: "active",
			event: "register",
			exportId: "take",
		});
		expect(registry.transition({ type: "finish", id: "take", controller: second })).toBe(false);
		registry.transition({ type: "cancel", id: "take", at: 2 });
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		expect(registry.active("take")).toBe(true);
		expect(registry.transition({ type: "finish", id: "take", controller: first })).toBe(true);
		expect(registry.active("take")).toBe(false);
	} finally {
		log.mockRestore();
	}
});

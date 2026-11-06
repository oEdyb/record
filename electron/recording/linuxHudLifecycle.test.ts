import { expect, it, vi } from "vitest";
import { LinuxHudLifecycle } from "./linuxHudLifecycle";

it("rejects showing controls over a live capture and logs the illegal move", () => {
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const lifecycle = new LinuxHudLifecycle();
	lifecycle.transition({ type: "conceal" });
	expect(lifecycle.transition({ type: "show", capturing: true })).toBe(false);
	expect(lifecycle.state.kind).toBe("concealed");
	expect(log).toHaveBeenCalledWith("[linux-hud] Illegal transition", {
		state: "concealed",
		event: "show",
	});
	log.mockRestore();
});
it("rejects a retired retry and proof without changing its replacement's ownership", () => {
	const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const lifecycle = new LinuxHudLifecycle();
	const owner = Symbol("old");
	const replacement = Symbol("replacement");
	const timer = setTimeout(() => undefined, 500);
	lifecycle.transition({ type: "prepare", owner, hide: true });
	lifecycle.transition({ type: "recover" });
	lifecycle.transition({ type: "schedule", timer });
	lifecycle.transition({ type: "cancel" });
	lifecycle.transition({ type: "prepare", owner: replacement, hide: true });
	const expected = lifecycle.state;
	expect(lifecycle.transition({ type: "tick", timer })).toBe(false);
	expect(lifecycle.transition({ type: "proof", owner, retained: true })).toBe(false);
	expect(lifecycle.transition({ type: "finish", owner })).toBe(false);
	expect(lifecycle.state).toBe(expected);
	expect(lifecycle.transition({ type: "admit", owner: replacement })).toBe(true);
	expect(log).toHaveBeenCalledTimes(3);
	lifecycle.transition({ type: "cancel" });
	log.mockRestore();
});
